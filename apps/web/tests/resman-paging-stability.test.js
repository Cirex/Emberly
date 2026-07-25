const assert = require("node:assert/strict");
const test = require("node:test");

const { listResource } = require("../lib/resman-api");
const {
  workOrdersResource,
  unitsResource,
  transactionsResource,
  leasesResource,
} = require("../lib/resman-resources");

/**
 * Every paged list must sort by a TOTAL order, ending in the primary key.
 *
 * Offset paging over a tied sort column is non-deterministic: Postgres may order
 * tied rows differently for each page request, so one row lands on two pages
 * while another lands on none. This was not theoretical. Measured against the
 * live mirror:
 *
 *   work-orders sorts by date_reported — 284 distinct values across 4,072 rows,
 *   with 99 rows sharing a single date. Paging the whole table returned 4,001
 *   DISTINCT ids. 71 work orders were missing from every full load, silently,
 *   for as long as the endpoint has existed.
 *
 * It also made the maintenance app's row-count drift check disagree on every
 * tick, so a cheap delta poll became a full 3.78 MB re-download every 15s.
 *
 * Only `transactions` had ever declared a tiebreak, and even that is not unique.
 * So the guarantee belongs in the engine, not in each resource — this test pins
 * it there.
 */

/** Records the .order() calls a resource's list query makes, in order. */
function recordingClient(rows = []) {
  const orders = [];
  const query = {
    select: () => query,
    or: () => query,
    eq: () => query,
    gt: () => query,
    order: (column, opts) => {
      orders.push({ column, ascending: opts?.ascending });
      return query;
    },
    range: async () => ({ data: rows, error: null, count: rows.length }),
  };
  return { client: { from: () => query }, orders };
}

const RESOURCES = [
  ["work-orders", workOrdersResource],
  ["units", unitsResource],
  ["leases", leasesResource],
  ["transactions", transactionsResource],
];

for (const [name, resource] of RESOURCES) {
  test(`${name}: paging ends on the primary key, making the sort total`, async () => {
    const { client, orders } = recordingClient();
    await listResource(resource, new URLSearchParams(""), client);

    assert.ok(orders.length >= 2, `${name} applied only ${orders.length} sort key(s)`);
    // The declared sort still comes first — this must not change result ordering.
    assert.equal(orders[0].column, resource.order.column);
    assert.equal(orders[0].ascending, resource.order.ascending);
    // And the LAST key is the unique id, which is what makes pages disjoint.
    assert.equal(
      orders[orders.length - 1].column,
      resource.idColumn,
      `${name} must sort last by ${resource.idColumn}`,
    );
  });
}

test("an explicit tiebreak is preserved, and still followed by the id", async () => {
  // transactions declares ledger_sequence. That is meaningful ordering and must
  // survive — but it is not unique either, so the id still has to come last.
  const { client, orders } = recordingClient();
  await listResource(transactionsResource, new URLSearchParams(""), client);
  const columns = orders.map((o) => o.column);
  assert.deepEqual(columns, [
    transactionsResource.order.column,
    transactionsResource.tiebreak.column,
    transactionsResource.idColumn,
  ]);
});

test("the delta bound does not disturb the ordering", async () => {
  // The maintenance app sends both together; a filter must not drop a sort key.
  const { client, orders } = recordingClient();
  await listResource(
    workOrdersResource,
    new URLSearchParams("updated_since=2026-07-25T00:00:00.000Z"),
    client,
  );
  assert.equal(orders[orders.length - 1].column, workOrdersResource.idColumn);
});

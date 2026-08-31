const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

// The translations delta route pages a table directly rather than through the
// resource engine, so reaching it needs its auth and client stubbed. Installed
// before any require so every consumer resolves the fakes; this suite runs in
// its own process (the package.json `test` script runs each file separately),
// so the process-global mocks cannot leak into another file.
const state = { db: null };

mock.module("@/lib/resman-api-auth", () => ({
  requireResmanApiKey: async () => ({ ok: true, kind: "token", subject: { role: "admin" } }),
  // Re-exported unchanged: lib/resman-api imports it from here, and a partial
  // mock would silently strip the real capability check out of listResource.
  tokenForbiddenForResource: require("../lib/app-role-capabilities").tokenForbiddenForResource,
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const { listResource } = require("../lib/resman-api");
const {
  workOrdersResource,
  unitsResource,
  transactionsResource,
  leasesResource,
} = require("../lib/resman-resources");
const translationsRoute = require("../app/api/resman/work-orders/translations/route.ts");

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

// ── the translations delta route ────────────────────────────────────────────
//
// Same rule, a route that pages a table itself instead of going through the
// engine above. Its declared sort is updated_at, which is emphatically NOT
// unique: one translate pass upserts hundreds of rows inside the same
// millisecond. So the sort has to end on the primary key too.

/**
 * A client that serves offset pages the way Postgres does: sorted by the
 * declared .order() keys, with rows that tie on all of them shifted one
 * position per request. A sort that is not TOTAL therefore returns some rows
 * twice and others never — the real failure, not a synthetic one.
 */
function unstableTranslationsClient(rows) {
  let request = 0;
  return {
    from() {
      const orders = [];
      const filters = [];
      let lo = 0;
      let hi = Number.MAX_SAFE_INTEGER;
      const builder = {
        select: () => builder,
        eq(column, value) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        gt(column, value) {
          filters.push((row) => row[column] > value);
          return builder;
        },
        order(column, opts) {
          orders.push({ column, ascending: opts?.ascending });
          return builder;
        },
        range(from, to) {
          lo = from;
          hi = to;
          return builder;
        },
        // PostgREST builders are thenable and only run on await, which is why
        // the route can bolt `.gt()` on after `.range()`.
        then: (resolve, reject) => {
          const matching = rows.filter((row) => filters.every((keep) => keep(row)));
          const sorted = [...matching].sort((a, b) => {
            for (const { column, ascending } of orders) {
              if (a[column] !== b[column]) {
                return (a[column] < b[column] ? -1 : 1) * (ascending === false ? -1 : 1);
              }
            }
            return 0;
          });
          const shift = request++;
          const served = [];
          for (let i = 0; i < sorted.length;) {
            let end = i + 1;
            while (
              end < sorted.length &&
              orders.every(({ column }) => sorted[end][column] === sorted[i][column])
            ) {
              end++;
            }
            const tied = sorted.slice(i, end);
            for (let k = 0; k < tied.length; k++) served.push(tied[(k + shift) % tied.length]);
            i = end;
          }
          return Promise.resolve({ data: served.slice(lo, hi + 1), error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return builder;
    },
  };
}

/** One sync pass: every row stamped within the same millisecond. */
function sameMillisecondRows(count, lang = "es") {
  return Array.from({ length: count }, (_, i) => ({
    source_hash: `h-${String(i).padStart(5, "0")}`,
    translated_text: `${lang}:${i}`,
    target_lang: lang,
    updated_at: "2026-08-30T12:00:00.000Z",
  }));
}

async function getTranslations(query) {
  const response = await translationsRoute.GET(
    new Request(`https://emberly.test/api/resman/work-orders/translations?${query}`),
  );
  return (await response.json()).data;
}

test("translations: a page boundary inside one timestamp skips no row", async () => {
  // 1,200 rows over a 1,000-row page, all sharing an updated_at. Sorting by
  // updated_at alone leaves them all tied, so the second page starts one row
  // late and that translation never reaches the device — invisibly, because a
  // content-addressed cache cannot tell a missing key from one it never needed.
  state.db = unstableTranslationsClient(sameMillisecondRows(1200));
  const data = await getTranslations("lang=es");

  assert.equal(data.count, 1200);
  assert.equal(Object.keys(data.entries).length, 1200);
  assert.equal(data.entries["h-01000"], "es:1000");
});

test("translations: the incremental pull is stable too", async () => {
  // `since` narrows the set but does not make the remaining timestamps unique —
  // a device polling deltas is exactly where a silent gap would persist.
  const rows = [
    ...sameMillisecondRows(1200),
    ...sameMillisecondRows(3, "en"), // wrong language: must stay filtered out
  ];
  state.db = unstableTranslationsClient(rows);
  const data = await getTranslations("lang=es&since=2026-08-30T11:00:00.000Z");

  assert.equal(data.count, 1200);
  assert.ok(Object.keys(data.entries).every((hash) => data.entries[hash].startsWith("es:")));
});

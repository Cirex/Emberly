const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ACTION_UNIT_ID_CHUNK,
  listDelinquencyActionsForUnits,
} = require("../lib/delinquency-actions");

/**
 * The delinquency board's action timeline, and the URL budget it spends.
 *
 * PostgREST takes filters in the query string, so an `.in()` list is spent URL
 * length. This function used to put EVERY qualifying unit id in one filter.
 * The board qualifies each unit that owes money or carries a collections note
 * — 234 on this property — which produced a 9,380-character request line,
 * earned a bare `414 Request URI Too Long`, and took the whole
 * /api/resman/manager/delinquency endpoint down with a 500. The Money board
 * showed nothing, with no error anywhere the app could see.
 *
 * The bug was load-dependent: fine at 100 delinquent units, fatal past ~200.
 * These tests pin the chunking so it cannot come back as the property grows.
 */

/** A stub client that records the id lists it is asked to filter on. */
function recordingClient(rowsByCall = []) {
  const calls = [];
  return {
    calls,
    from() {
      const q = {
        select: () => q,
        in: (col, ids) => {
          calls.push({ col, ids });
          return q;
        },
        is: () => q,
        order: () => Promise.resolve({ data: rowsByCall[calls.length - 1] ?? [], error: null }),
      };
      return q;
    },
  };
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("no units means no query at all", async () => {
  const client = recordingClient();
  assert.deepEqual(await listDelinquencyActionsForUnits(client, []), []);
  assert.equal(client.calls.length, 0);
});

test("a small board still takes exactly one request", async () => {
  const client = recordingClient();
  await listDelinquencyActionsForUnits(client, [uuid(1), uuid(2), uuid(3)]);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].ids.length, 3);
});

test("234 units — the count that 414'd — is split, and every id is still asked for", async () => {
  const ids = Array.from({ length: 234 }, (_, i) => uuid(i));
  const client = recordingClient();
  await listDelinquencyActionsForUnits(client, ids);

  assert.ok(client.calls.length > 1, "must not be one giant filter again");
  assert.deepEqual(
    client.calls.flatMap((c) => c.ids),
    ids,
    "every unit id must still be queried, in order, with none dropped",
  );
  for (const call of client.calls) {
    assert.ok(call.ids.length <= ACTION_UNIT_ID_CHUNK, "no chunk may exceed the cap");
  }
});

test("the longest request line stays well inside the ~8KB server limit", async () => {
  const ids = Array.from({ length: 234 }, (_, i) => uuid(i));
  const client = recordingClient();
  await listDelinquencyActionsForUnits(client, ids);

  // Reconstruct the filter PostgREST would receive; a UUID plus its comma is
  // 37 chars, and the real 414 happened at 9,380.
  for (const call of client.calls) {
    const filter = `resman_unit_id=in.(${call.ids.join(",")})`;
    assert.ok(filter.length < 6_500, `filter was ${filter.length} chars — too close to the limit`);
  }
});

test("the merged timeline is newest-first ACROSS chunks, not just inside them", async () => {
  const ids = Array.from({ length: ACTION_UNIT_ID_CHUNK + 10 }, (_, i) => uuid(i));
  const row = (id, createdAt) => ({
    id, resman_lease_id: "L", resman_unit_id: "U", unit_number: "1", kind: "note",
    note: "", amount: null, promise_due_date: null, created_by: "", created_at: createdAt,
  });
  // Each chunk is sorted on its own; concatenating them is NOT sorted.
  const client = recordingClient([
    [row("a", "2026-01-01T00:00:00Z")],
    [row("b", "2026-08-01T00:00:00Z")],
  ]);
  const out = await listDelinquencyActionsForUnits(client, ids);
  assert.deepEqual(out.map((r) => r.id), ["b", "a"]);
});

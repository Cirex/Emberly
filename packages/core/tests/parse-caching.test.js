const { test } = require("node:test");
const assert = require("node:assert");
const { parseAll, parseWorkOrder } = require("../dist");

/**
 * Parsing caches its expensive halves against the RAW ROW OBJECT.
 *
 * Two things dominate a parse of the live mirror: deriving tags (a text
 * normalization plus some two hundred phrase probes, per row) and fingerprinting
 * for the duplicate/callback engine (another ~50 string passes, per row). Both
 * read only from the row, so an unchanged row keeps its answer — and a delta sync
 * reuses the objects it did not replace, which is what makes a sync after a
 * three-row change cost three rows of work instead of four thousand.
 *
 * The danger is a stale answer surviving a change. These tests pin both halves:
 * a reused object must give the SAME result, and a replaced one must be
 * re-derived. They also pin the invariant the whole scheme rests on — that
 * nothing hands back a shared mutable parse.
 */

let seq = 0;
function row(fields) {
  seq += 1;
  return {
    resman_work_order_id: `wo-${seq}`,
    number: String(seq),
    unit_number: "0101",
    status: "Open",
    priority: "Normal",
    category: "",
    title: "",
    notes: "",
    completion_notes: "",
    technician: "",
    date_reported: null,
    date_scheduled: null,
    date_completed: null,
    is_make_ready: false,
    tags: [],
    is_duplicate: false,
    callback_status: "none",
    callback_matched_work_order_id: "",
    ...fields,
  };
}

test("a reused row parses identically to a fresh one", () => {
  const raw = row({ title: "AC not cooling, blowing warm air", notes: "thermostat set to 68" });
  const first = parseWorkOrder(raw);
  const second = parseWorkOrder(raw); // cache hit
  const fresh = parseWorkOrder({ ...raw }); // cache miss, same content

  assert.deepEqual(second.tags, first.tags);
  assert.deepEqual(fresh.tags, first.tags);
  assert.equal(second.searchKey, first.searchKey);
  assert.equal(fresh.searchKey, first.searchKey);
  assert.ok(first.tags.includes("HVAC"), "fixture should tag HVAC");
});

test("a cache hit still returns a FRESH parse object", () => {
  // parseAll writes callback/duplicate signals onto parsed rows afterwards.
  // Handing back a shared instance would let a later parse mutate rows an
  // earlier snapshot is still rendering.
  const raw = row({ title: "Kitchen sink leaking" });
  const first = parseWorkOrder(raw);
  const second = parseWorkOrder(raw);
  assert.notStrictEqual(second, first);

  first.isDuplicate = true;
  assert.equal(parseWorkOrder(raw).isDuplicate, false, "mutation leaked into the cache");
});

test("replacing a row re-derives its tags", () => {
  const before = row({ title: "AC not cooling" });
  assert.ok(parseWorkOrder(before).tags.includes("HVAC"));

  // What a delta sync produces for a changed row: a NEW object.
  const after = { ...before, title: "Kitchen sink is clogged" };
  const tags = parseWorkOrder(after).tags;
  assert.ok(!tags.includes("HVAC"), `stale tags survived a change: ${tags.join(",")}`);
  assert.ok(tags.includes("Clogs"), `expected Clogs, got: ${tags.join(",")}`);
});

test("the duplicate engine sees changed prose through a reused set", () => {
  // Same unit, both open: identical prose is the engine's duplicate case. The
  // fingerprint cache must not hide a row whose prose was edited away from it.
  // Reported dates are required: the engine refuses to call anything a
  // duplicate when it cannot measure the distance between the two reports.
  const a = row({
    unit_number: "0101",
    title: "Toilet running constantly",
    status: "Open",
    date_reported: "2026-07-20T09:00:00",
  });
  const b = row({
    unit_number: "0101",
    title: "Toilet running constantly",
    status: "Open",
    date_reported: "2026-07-22T09:00:00",
  });
  const flagged = parseAll([a, b]);
  assert.ok(
    flagged[0].isDuplicate && flagged[1].isDuplicate,
    "identical open orders in one unit should flag as duplicates",
  );

  // Re-run with `b` replaced by an unrelated issue: `a` keeps its object (cache
  // hit) but must no longer be a duplicate.
  const bChanged = { ...b, title: "Replace porch light bulb" };
  const rerun = parseAll([a, bChanged]);
  assert.equal(rerun[0].isDuplicate, false, "duplicate flag survived the other row changing");
  assert.equal(rerun[1].isDuplicate, false);
});

test("re-parsing an unchanged set is stable, not merely fast", () => {
  const rows = [
    row({ title: "No hot water", unit_number: "0201" }),
    row({ title: "Dishwasher not draining", unit_number: "0202" }),
    row({ title: "Roaches in kitchen", unit_number: "0203" }),
  ];
  const first = parseAll(rows);
  const second = parseAll(rows);
  assert.deepEqual(
    second.map((p) => [p.id, p.tags, p.isDuplicate, p.callbackStatus, p.searchKey]),
    first.map((p) => [p.id, p.tags, p.isDuplicate, p.callbackStatus, p.searchKey]),
  );
});

const assert = require("node:assert/strict");
const test = require("node:test");

/**
 * `?updated_since=` — the delta read the maintenance app polls on.
 *
 * The parameter only means anything because resman_work_orders has a
 * CHANGE-DETECTING updated_at trigger
 * (deltas/2026-07-24-work-order-change-detection.sql). With the default
 * unconditional trigger, upsertMirror's idempotent re-write of every scraped row
 * bumps every timestamp each pass and this filter returns the whole table — the
 * exact opposite of its purpose. That is a DB-side property; what is pinned here
 * is the query construction.
 */

const { resolveSince } = require("../lib/resman-api");
const { workOrdersResource, unitsResource, leasesResource } = require("../lib/resman-resources");

function params(query) {
  return new URLSearchParams(query);
}

test("work orders opt into the delta bound; other resources do not", () => {
  assert.deepEqual(workOrdersResource.since, { param: "updated_since", column: "updated_at" });
  // Opting a resource in without a change-detecting trigger on its table would
  // hand callers a filter that silently returns everything.
  assert.equal(unitsResource.since, undefined);
  assert.equal(leasesResource.since, undefined);
});

test("an ISO timestamp resolves to a normalized bound", () => {
  const since = resolveSince(workOrdersResource, params("updated_since=2026-07-24T12:00:00.000Z"));
  assert.deepEqual(since, { column: "updated_at", value: "2026-07-24T12:00:00.000Z" });
});

test("a non-UTC timestamp is normalized, not passed through", () => {
  // The device sends back what the server gave it, but a hand-built request may
  // carry an offset. PostgREST compares timestamptz, so the value must be
  // unambiguous.
  const since = resolveSince(workOrdersResource, params("updated_since=2026-07-24T08:00:00-04:00"));
  assert.equal(since.value, "2026-07-24T12:00:00.000Z");
});

test("absent or blank means no bound", () => {
  assert.equal(resolveSince(workOrdersResource, params("")), null);
  assert.equal(resolveSince(workOrdersResource, params("updated_since=")), null);
  assert.equal(resolveSince(workOrdersResource, params("updated_since=%20%20")), null);
});

test("a garbage timestamp FAILS OPEN — full list, never an empty one", () => {
  // This is the important direction. Rejecting the request (or, worse, coercing
  // to an epoch-0 or now() bound) would let a client bug hide every work order
  // on a technician's board. A wider result is merely expensive.
  assert.equal(resolveSince(workOrdersResource, params("updated_since=yesterday")), null);
  assert.equal(resolveSince(workOrdersResource, params("updated_since=NaN")), null);
  // `new Date()` reads these as real dates — "0" as the year 2000 and "3000" as
  // the year 3000. The second is the dangerous one: a future bound matches
  // nothing, so a technician's board would render EMPTY and look like a
  // property with no open work.
  assert.equal(resolveSince(workOrdersResource, params("updated_since=0")), null);
  assert.equal(resolveSince(workOrdersResource, params("updated_since=3000")), null);
  // A bare date with no time is also ambiguous (local vs UTC midnight).
  assert.equal(resolveSince(workOrdersResource, params("updated_since=2026-07-24")), null);
});

test("a resource without `since` ignores the param entirely", () => {
  assert.equal(resolveSince(unitsResource, params("updated_since=2026-07-24T12:00:00.000Z")), null);
});

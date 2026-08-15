const { test } = require("node:test");
const assert = require("node:assert");
const { TENURE_BUCKETS, daysSinceMoveIn, tenureBucket } = require("../dist");

/**
 * Tenure bands answer a different question from the aging buckets: aging is
 * how old the DEBT is, tenure is how long the TENANCY is. The same 90+ balance
 * is a screening problem on a three-week resident and a life-event problem on
 * a five-year one.
 *
 * The bands are tight early because that is where risk moves fastest —
 * measured across the property, delinquency runs 28% in the first six months,
 * peaks at 41% between six and twelve, then settles near 29% and falls to 20%
 * past five years.
 */

test("each boundary belongs to the band it names", () => {
  assert.equal(tenureBucket(0), "0-30");
  assert.equal(tenureBucket(30), "0-30");
  assert.equal(tenureBucket(31), "31-60");
  assert.equal(tenureBucket(60), "31-60");
  assert.equal(tenureBucket(61), "61-90");
  assert.equal(tenureBucket(90), "61-90");
  assert.equal(tenureBucket(91), "91-120");
  assert.equal(tenureBucket(120), "91-120");
  assert.equal(tenureBucket(121), "121-180");
  assert.equal(tenureBucket(180), "121-180");
  assert.equal(tenureBucket(181), "181-365");
  assert.equal(tenureBucket(365), "181-365");
  assert.equal(tenureBucket(366), "1yr+");
});

test("a future-dated move-in folds into the first band rather than vanishing", () => {
  // ResMan carries move-in dates on approved-but-not-arrived leases, and a
  // negative tenure must still land somewhere or the row drops out of the
  // grouped view entirely.
  assert.equal(tenureBucket(-5), "0-30");
});

test("every band tenureBucket can return is declared in TENURE_BUCKETS", () => {
  const produced = new Set([-1, 0, 30, 31, 60, 61, 90, 91, 120, 121, 180, 181, 365, 366, 5000].map(tenureBucket));
  for (const bucket of produced) assert.ok(TENURE_BUCKETS.includes(bucket), `${bucket} missing`);
});

test("days are counted from LOCAL midnight, so a same-day move-in is day 0", () => {
  const now = new Date(2026, 7, 15, 9, 30).getTime(); // Aug 15 2026, 09:30 local
  assert.equal(daysSinceMoveIn("2026-08-15", now), 0);
  assert.equal(daysSinceMoveIn("2026-08-14", now), 1);
  // A UTC parse would shift the date back and report 1 for a same-day move-in.
  assert.equal(tenureBucket(daysSinceMoveIn("2026-08-15", now)), "0-30");
});

test("a full ISO timestamp works, and an unparseable date is null not zero", () => {
  const now = new Date(2026, 7, 15, 9, 30).getTime();
  assert.equal(daysSinceMoveIn("2026-07-16T00:00:00Z", now), 30);
  assert.equal(daysSinceMoveIn(null, now), null);
  assert.equal(daysSinceMoveIn("", now), null);
  assert.equal(daysSinceMoveIn("not a date", now), null, "null keeps the row in 'unknown' rather than 'first 30 days'");
});

test("the six-year resident from 1732 ST-2 lands in 1yr+", () => {
  const now = new Date(2026, 7, 15).getTime();
  assert.equal(tenureBucket(daysSinceMoveIn("2020-07-20", now)), "1yr+");
});

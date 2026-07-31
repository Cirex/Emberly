const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPeriodBuckets,
  calendarInZone,
  keyForValue,
  MAX_PERIOD_BUCKETS,
  parseCalendarPrefix,
  periodKey,
  periodNext,
  periodStart,
  zonedMidnightUtc,
} = require("../lib/period-buckets");

/**
 * Calendar arithmetic for time-series aggregates.
 *
 * The whole point of the date/timestamp split is that a plain DATE has no
 * timezone and must not be converted, while an instant must be — so most of
 * these tests are about not applying the wrong one.
 */

// ------------------------------------------------------- calendar floors ---

test("periodStart floors to the containing period", () => {
  const d = { y: 2026, m: 5, d: 14 }; // Thursday
  assert.deepEqual(periodStart(d, "day"), { y: 2026, m: 5, d: 14 });
  assert.deepEqual(periodStart(d, "week"), { y: 2026, m: 5, d: 11 }, "weeks start Monday");
  assert.deepEqual(periodStart(d, "month"), { y: 2026, m: 5, d: 1 });
  assert.deepEqual(periodStart(d, "quarter"), { y: 2026, m: 4, d: 1 });
  assert.deepEqual(periodStart(d, "year"), { y: 2026, m: 1, d: 1 });
});

test("a week floor crosses a month and a year boundary correctly", () => {
  // 2026-01-01 is a Thursday, so its week starts Monday 2025-12-29.
  assert.deepEqual(periodStart({ y: 2026, m: 1, d: 1 }, "week"), { y: 2025, m: 12, d: 29 });
  // 2026-03-02 is a Monday — already the start.
  assert.deepEqual(periodStart({ y: 2026, m: 3, d: 2 }, "week"), { y: 2026, m: 3, d: 2 });
});

test("periodNext rolls over months, quarters and years", () => {
  assert.deepEqual(periodNext({ y: 2026, m: 12, d: 1 }, "month"), { y: 2027, m: 1, d: 1 });
  assert.deepEqual(periodNext({ y: 2026, m: 10, d: 1 }, "quarter"), { y: 2027, m: 1, d: 1 });
  assert.deepEqual(periodNext({ y: 2026, m: 12, d: 31 }, "day"), { y: 2027, m: 1, d: 1 });
});

test("day arithmetic handles leap years", () => {
  assert.deepEqual(periodNext({ y: 2028, m: 2, d: 28 }, "day"), { y: 2028, m: 2, d: 29 }, "2028 is a leap year");
  assert.deepEqual(periodNext({ y: 2026, m: 2, d: 28 }, "day"), { y: 2026, m: 3, d: 1 }, "2026 is not");
  // Century rule: 2100 is NOT a leap year.
  assert.deepEqual(periodNext({ y: 2100, m: 2, d: 28 }, "day"), { y: 2100, m: 3, d: 1 });
});

test("period labels are sortable as strings", () => {
  assert.equal(periodKey({ y: 2026, m: 3, d: 1 }, "month"), "2026-03");
  assert.equal(periodKey({ y: 2026, m: 4, d: 1 }, "quarter"), "2026-Q2");
  assert.equal(periodKey({ y: 2026, m: 1, d: 5 }, "day"), "2026-01-05");
  assert.equal(periodKey({ y: 2026, m: 1, d: 1 }, "year"), "2026");
  // A chart axis is built by sorting these, so lexical order must be chronological.
  const keys = ["2026-10", "2026-02", "2026-01"].sort();
  assert.deepEqual(keys, ["2026-01", "2026-02", "2026-10"]);
});

// ------------------------------------------------------------- buckets -----

test("buckets are half-open and contiguous, so no row is counted twice", () => {
  const buckets = buildPeriodBuckets({ y: 2026, m: 1, d: 15 }, { y: 2026, m: 3, d: 2 }, "month", "date");
  assert.deepEqual(buckets.map((b) => b.key), ["2026-01", "2026-02", "2026-03"]);
  assert.equal(buckets[0].from, "2026-01-01");
  assert.equal(buckets[0].to, "2026-02-01");
  // Each bucket's exclusive end IS the next bucket's inclusive start.
  assert.equal(buckets[0].to, buckets[1].from);
  assert.equal(buckets[1].to, buckets[2].from);
});

test("the period containing the last value is included", () => {
  const buckets = buildPeriodBuckets({ y: 2026, m: 1, d: 1 }, { y: 2026, m: 1, d: 1 }, "month", "date");
  assert.deepEqual(buckets.map((b) => b.key), ["2026-01"], "a single-day window still yields its month");
});

test("an absurd window is refused rather than silently shortened", () => {
  assert.throws(
    () => buildPeriodBuckets({ y: 2000, m: 1, d: 1 }, { y: 2026, m: 1, d: 1 }, "day", "date"),
    new RegExp(`more than ${MAX_PERIOD_BUCKETS}`),
  );
});

// ------------------------------------------------------------ timezones ----

test("a DATE column is bucketed with no timezone conversion at all", () => {
  // The bound must come back as the same calendar date it went in as. Converting
  // it would shift a bill dated the 1st into the previous month.
  const buckets = buildPeriodBuckets({ y: 2026, m: 3, d: 1 }, { y: 2026, m: 3, d: 1 }, "month", "date", "Asia/Tokyo");
  assert.equal(buckets[0].from, "2026-03-01");
  assert.equal(keyForValue("2026-03-01", "month", "date", "Asia/Tokyo"), "2026-03");
});

test("a TIMESTAMP bucket boundary is local midnight expressed as an instant", () => {
  // Memphis is UTC-6 in winter, so local midnight on 2026-01-05 is 06:00Z.
  const utc = zonedMidnightUtc({ y: 2026, m: 1, d: 5 }, "America/Chicago");
  assert.equal(new Date(utc).toISOString(), "2026-01-05T06:00:00.000Z");
  // …and UTC-5 in summer, so July is 05:00Z. A fixed offset would be wrong here.
  const summer = zonedMidnightUtc({ y: 2026, m: 7, d: 5 }, "America/Chicago");
  assert.equal(new Date(summer).toISOString(), "2026-07-05T05:00:00.000Z");
});

test("a late-night scan belongs to the local night, not the UTC one", () => {
  // 2026-01-06T04:30Z is 10:30pm on the 5th in Memphis. Bucketing this in UTC
  // would file a Monday-night entry under Tuesday.
  assert.equal(keyForValue("2026-01-06T04:30:00Z", "day", "timestamp", "America/Chicago"), "2026-01-05");
  assert.equal(keyForValue("2026-01-06T04:30:00Z", "day", "timestamp", "UTC"), "2026-01-06");
});

test("calendarInZone reads the local date of an instant", () => {
  assert.deepEqual(calendarInZone("2026-01-06T04:30:00Z", "America/Chicago"), { y: 2026, m: 1, d: 5 });
  assert.equal(calendarInZone("not a date", "America/Chicago"), null);
});

test("bucketing survives the spring-forward day", () => {
  // 2026-03-08 is the US DST change: that local day is 23 hours long. The
  // boundaries either side must still be consecutive local midnights.
  const buckets = buildPeriodBuckets({ y: 2026, m: 3, d: 7 }, { y: 2026, m: 3, d: 9 }, "day", "timestamp", "America/Chicago");
  assert.deepEqual(buckets.map((b) => b.key), ["2026-03-07", "2026-03-08", "2026-03-09"]);
  assert.equal(buckets[0].to, buckets[1].from, "no gap or overlap across the DST change");
  assert.equal(new Date(buckets[1].from).toISOString(), "2026-03-08T06:00:00.000Z");
  assert.equal(new Date(buckets[1].to).toISOString(), "2026-03-09T05:00:00.000Z", "the day after is one hour shorter");
});

// ---------------------------------------------------------------- parsing --

test("parseCalendarPrefix accepts a date or a timestamp, rejects junk", () => {
  assert.deepEqual(parseCalendarPrefix("2026-01-05"), { y: 2026, m: 1, d: 5 });
  assert.deepEqual(parseCalendarPrefix("2026-01-05T13:00:00Z"), { y: 2026, m: 1, d: 5 });
  assert.equal(parseCalendarPrefix("last tuesday"), null);
});

// ------------------------------------------------------- label round-trip ---

const { parsePeriodKey, fillPeriodGaps } = require("../lib/period-buckets");

test("period labels round-trip back to the date they start on", () => {
  // The SQL aggregate returns only periods that HAVE rows, so filling a series'
  // gaps means reading its own labels back as dates.
  assert.deepEqual(parsePeriodKey("2026-03", "month"), { y: 2026, m: 3, d: 1 });
  assert.deepEqual(parsePeriodKey("2026-Q3", "quarter"), { y: 2026, m: 7, d: 1 });
  assert.deepEqual(parsePeriodKey("2026", "year"), { y: 2026, m: 1, d: 1 });
  assert.deepEqual(parsePeriodKey("2026-01-05", "day"), { y: 2026, m: 1, d: 5 });
  assert.equal(parsePeriodKey("garbage", "month"), null);
});

test("every interval's label survives a key -> parse -> key round trip", () => {
  for (const [interval, key] of [
    ["day", "2026-01-05"], ["week", "2026-03-02"], ["month", "2026-11"],
    ["quarter", "2026-Q4"], ["year", "2026"],
  ]) {
    assert.equal(periodKey(parsePeriodKey(key, interval), interval), key, `${interval} label is lossy`);
  }
});

test("gaps in a series are filled between the first and last period present", () => {
  // A month with no rows must appear at zero. A series that silently skips a
  // month reads as continuous, hiding the gap the question is about.
  assert.deepEqual(
    fillPeriodGaps(["2026-01", "2026-04"], "month"),
    ["2026-01", "2026-02", "2026-03", "2026-04"],
  );
  assert.deepEqual(fillPeriodGaps(["2025-Q4", "2026-Q2"], "quarter"), ["2025-Q4", "2026-Q1", "2026-Q2"]);
  assert.deepEqual(fillPeriodGaps([], "month"), [], "nothing present, nothing to fill");
  assert.deepEqual(fillPeriodGaps(["2026-05"], "month"), ["2026-05"], "a single period needs no filling");
});

test("gap filling refuses to pad past the bucket ceiling", () => {
  // Two daily labels years apart would otherwise expand to thousands of rows.
  const out = fillPeriodGaps(["2020-01-01", "2026-01-01"], "day");
  assert.deepEqual(out, ["2020-01-01", "2026-01-01"], "returns what it had rather than padding");
});

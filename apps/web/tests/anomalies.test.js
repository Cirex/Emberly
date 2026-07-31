const assert = require("node:assert/strict");
const test = require("node:test");

const { detectAnomalies, toAnomalyInputs, MIN_BASELINE_PERIODS } = require("../lib/anomalies");

/**
 * Anomaly scoring. The property this has to hold is that an entity is judged
 * against ITSELF: a big account must not be permanently flagged for being big,
 * and a small account's tripling must not be buried by the portfolio total.
 */

const flat = (entity, periods, value) => periods.map((period) => ({ entity, period, value }));

test("an entity is scored against its own history, not against other entities", () => {
  const rows = [
    // A large but perfectly steady account — must NOT be flagged.
    ...flat("big", ["2026-01", "2026-02", "2026-03", "2026-04"], 1000),
    // A small account that tripled — must be flagged.
    ...flat("small", ["2026-01", "2026-02", "2026-03"], 10),
    { entity: "small", period: "2026-04", value: 30 },
  ];
  const report = detectAnomalies(rows);
  assert.equal(report.focus_period, "2026-04");
  assert.equal(report.anomalies[0].entity, "small", "the small tripling outranks the large steady account");
  assert.ok(!report.anomalies.some((a) => a.entity === "big" && a.z !== null && Math.abs(a.z) > 1));
});

test("direction and percent change are reported alongside the score", () => {
  const rows = [
    ...flat("acct", ["2026-01", "2026-02", "2026-03"], 100),
    { entity: "acct", period: "2026-04", value: 150 },
  ];
  const [a] = detectAnomalies(rows).anomalies;
  assert.equal(a.direction, "up");
  assert.equal(a.baseline_mean, 100);
  assert.equal(a.pct_change, 50);
  assert.equal(a.baseline_periods, 3);
});

test("a drop is an anomaly too", () => {
  const rows = [
    { entity: "a", period: "2026-01", value: 100 },
    { entity: "a", period: "2026-02", value: 110 },
    { entity: "a", period: "2026-03", value: 90 },
    { entity: "a", period: "2026-04", value: 5 },
  ];
  const [a] = detectAnomalies(rows).anomalies;
  assert.equal(a.direction, "down");
  assert.ok(a.z < 0);
});

test("a flat history falls back to percent change instead of scoring infinity", () => {
  // stddev is exactly 0 here, so (value - mean) / stddev is Infinity — a true
  // statement that ranks uselessly. The fallback must be labelled, not hidden.
  const rows = [
    ...flat("steady", ["2026-01", "2026-02", "2026-03"], 40),
    { entity: "steady", period: "2026-04", value: 60 },
  ];
  const [a] = detectAnomalies(rows).anomalies;
  assert.equal(a.z, null);
  assert.equal(a.method, "pct_change");
  assert.equal(a.pct_change, 50);
  assert.ok(Number.isFinite(a.baseline_stddev));
});

test("an entity without enough history is not scored at all", () => {
  const rows = [
    { entity: "new", period: "2026-03", value: 10 },
    { entity: "new", period: "2026-04", value: 900 },
  ];
  const report = detectAnomalies(rows);
  assert.equal(report.anomalies.length, 0, `fewer than ${MIN_BASELINE_PERIODS} baseline periods cannot be judged`);
  assert.equal(report.entities_scored, 0);
  assert.match(report.notes[0], /prior periods/);
});

test("an entity absent from the focus period is skipped, not counted as zero", () => {
  // "No bill this month" and "a bill of 0.00" are different claims. Treating
  // absence as zero would manufacture a -100% anomaly for every account that
  // simply had not been billed yet.
  const rows = [
    ...flat("gone", ["2026-01", "2026-02", "2026-03"], 50),
    ...flat("here", ["2026-01", "2026-02", "2026-03"], 50),
    { entity: "here", period: "2026-04", value: 80 },
  ];
  const report = detectAnomalies(rows);
  assert.deepEqual(report.anomalies.map((a) => a.entity), ["here"]);
});

test("multiple rows in one period are summed before scoring", () => {
  const rows = [
    ...flat("a", ["2026-01", "2026-02", "2026-03"], 100),
    { entity: "a", period: "2026-04", value: 60 },
    { entity: "a", period: "2026-04", value: 60 },
  ];
  const [a] = detectAnomalies(rows).anomalies;
  assert.equal(a.value, 120, "two bills in a month are one month's spend");
});

test("the focus period can be pinned rather than inferred", () => {
  const rows = [
    ...flat("a", ["2026-01", "2026-02", "2026-03"], 10),
    { entity: "a", period: "2026-04", value: 99 },
  ];
  const report = detectAnomalies(rows, { focusPeriod: "2026-03" });
  assert.equal(report.focus_period, "2026-03");
  assert.equal(report.anomalies[0].value, 10, "2026-03 is judged, not the later spike");
});

test("results are capped and ranked by magnitude", () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push(...flat(`e${i}`, ["2026-01", "2026-02", "2026-03"], 100));
    rows.push({ entity: `e${i}`, period: "2026-04", value: 100 + i * 10 });
  }
  const report = detectAnomalies(rows, { limit: 3 });
  assert.equal(report.anomalies.length, 3);
  assert.equal(report.anomalies[0].entity, "e9", "largest deviation first");
});

test("an unpopulated measure reports 'nothing to score', not 'no anomalies'", () => {
  // MLGW publishes no water readings on these accounts. "No water anomalies"
  // and "no water data" are different claims and must not be conflated.
  const report = detectAnomalies([]);
  assert.equal(report.anomalies.length, 0);
  assert.match(report.notes[0], /NOT 'no anomalies'/);
});

// ------------------------------------------------------------ projection ---

test("toAnomalyInputs drops nulls rather than coercing them to zero", () => {
  const rows = [
    { acct: "a", bill_date: "2026-01-05", amount: 100 },
    { acct: "a", bill_date: "2026-02-05", amount: null },   // Number(null) is 0
    { acct: null, bill_date: "2026-02-05", amount: 50 },    // no entity
    { acct: "a", bill_date: null, amount: 50 },             // no date
    { acct: "a", bill_date: "not a date", amount: 50 },     // unparseable
  ];
  const out = toAnomalyInputs(rows, {
    entityColumn: "acct", periodColumn: "bill_date", measure: "amount",
    interval: "month", kind: "date", timezone: "America/Chicago",
  });
  assert.deepEqual(out, [{ entity: "a", period: "2026-01", value: 100 }]);
});

test("toAnomalyInputs buckets timestamps in the given zone", () => {
  const out = toAnomalyInputs(
    [{ e: "x", at: "2026-01-06T04:30:00Z", v: 1 }],
    { entityColumn: "e", periodColumn: "at", measure: "v", interval: "day", kind: "timestamp", timezone: "America/Chicago" },
  );
  assert.equal(out[0].period, "2026-01-05", "a 10:30pm Memphis scan belongs to that evening");
});

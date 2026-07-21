const { test } = require("node:test");
const assert = require("node:assert");
const {
  AGING_BUCKETS,
  BALANCE_HEAT_LEGEND,
  EVICTION_HEAT_COLOR,
  MARGINAL_PER_MONTH,
  agingBucket,
  balanceHeatColor,
  delinquencyPriority,
  netPosition,
  verdictFor,
} = require("../dist");

test("agingBucket picks the OLDEST column with money", () => {
  assert.equal(agingBucket({ currentMonthBalance: 100 }), "0-30");
  assert.equal(agingBucket({ currentMonthBalance: 100, lastMonthBalance: 20 }), "31-60");
  assert.equal(agingBucket({ lastMonthBalance: 20, periodBalance: 5 }), "61-90");
  assert.equal(agingBucket({ currentMonthBalance: 1, previousBalance: 0.01 }), "90+");
});

test("agingBucket returns null when the total balance is <= 0", () => {
  assert.equal(agingBucket({}), null);
  assert.equal(agingBucket({ balance: 0 }), null);
  assert.equal(agingBucket({ balance: -25, currentMonthBalance: 50 }), null); // explicit total wins
  // Positive total with a credit in one column: bucket by columns that ARE positive.
  assert.equal(agingBucket({ currentMonthBalance: 100, previousBalance: -10 }), "0-30");
});

test("agingBucket falls back to 0-30 when total is positive but no column is", () => {
  assert.equal(agingBucket({ balance: 75 }), "0-30");
});

test("AGING_BUCKETS is ordered youngest to oldest", () => {
  assert.deepEqual([...AGING_BUCKETS], ["0-30", "31-60", "61-90", "90+"]);
});

test("balanceHeatColor: 5-step ramp with inclusive upper bounds", () => {
  assert.equal(balanceHeatColor(0, false), "#FFFFFF");
  assert.equal(balanceHeatColor(-50, false), "#FFFFFF");
  assert.equal(balanceHeatColor(1, false), "#F8E7C8");
  assert.equal(balanceHeatColor(300, false), "#F8E7C8");
  assert.equal(balanceHeatColor(300.01, false), "#F3C08B");
  assert.equal(balanceHeatColor(800, false), "#F3C08B");
  assert.equal(balanceHeatColor(801, false), "#E88A5E");
  assert.equal(balanceHeatColor(1500, false), "#E88A5E");
  assert.equal(balanceHeatColor(1501, false), "#D1382E");
});

test("balanceHeatColor: eviction overrides the ramp at every balance", () => {
  assert.equal(balanceHeatColor(0, true), EVICTION_HEAT_COLOR);
  assert.equal(balanceHeatColor(9999, true), "#7A1F1F");
});

test("BALANCE_HEAT_LEGEND covers the ramp in order and ends with eviction", () => {
  assert.deepEqual(
    BALANCE_HEAT_LEGEND.map((i) => i.color),
    ["#FFFFFF", "#F8E7C8", "#F3C08B", "#E88A5E", "#D1382E", "#7A1F1F"],
  );
  assert.ok(BALANCE_HEAT_LEGEND.every((i) => typeof i.label === "string" && i.label.length > 0));
});

test("netPosition subtracts every cost bucket from collected", () => {
  const net = netPosition({
    collected: 12000,
    concessions: 500,
    badDebt: 1000,
    legal: 250,
    utilityExposure: 150,
    maintenanceEstimate: 600,
  });
  assert.equal(net, 9500);
});

test("verdictFor: loss < 0, marginal under threshold/month, else profitable", () => {
  assert.equal(verdictFor(-1, 12), "loss");
  assert.equal(verdictFor(0, 12), "marginal");
  assert.equal(verdictFor(12 * MARGINAL_PER_MONTH - 1, 12), "marginal");
  assert.equal(verdictFor(12 * MARGINAL_PER_MONTH, 12), "profitable");
  // monthsOccupied clamps to 1: no divide-by-zero, judged as a 1-month lease.
  assert.equal(verdictFor(MARGINAL_PER_MONTH, 0), "profitable");
  assert.equal(verdictFor(100, 0), "marginal");
});

test("delinquencyPriority follows the documented formula", () => {
  // 90+ (4*1000) + min(2000,5000)/10 + 3*50 + broken 500
  assert.equal(
    delinquencyPriority({ balance: 2000, agingBucket: "90+", timesLate: 3, brokenPromise: true }),
    4000 + 200 + 150 + 500,
  );
  // Balance caps at 5000; no bucket = age weight 0; negative balance clamps to 0.
  assert.equal(delinquencyPriority({ balance: 99999, agingBucket: "0-30", timesLate: 0 }), 1000 + 500);
  assert.equal(delinquencyPriority({ balance: 400, agingBucket: null, timesLate: 1 }), 40 + 50);
  assert.equal(delinquencyPriority({ balance: -100, agingBucket: null, timesLate: 0 }), 0);
});

test("delinquencyPriority: an older bucket outranks any balance in a younger one", () => {
  const youngWhale = delinquencyPriority({ balance: 5000, agingBucket: "61-90", timesLate: 0 });
  const oldSmall = delinquencyPriority({ balance: 10, agingBucket: "90+", timesLate: 0 });
  assert.ok(oldSmall > youngWhale);
});

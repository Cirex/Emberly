const assert = require("node:assert/strict");
const test = require("node:test");

const {
  HIGH_ELECTRIC_ABSOLUTE,
  feeItemsOf,
  accountSummaries,
  billDetailStats,
  buildLedgerTree,
  chargeSegmentsOf,
  currentMonthMix,
  detectExceptions,
  monthOverMonth,
  monthlySpendSeries,
  newChargesOf,
  waterTotalOf,
} = require("../lib/admin-utilities");

const NOW = Date.parse("2026-07-21T12:00:00Z");

function account(over = {}) {
  return {
    id: "acct-1",
    account_number: "9900000204",
    service_address: "4829 Emberly Ave Apt 204",
    unit_number: "204",
    resman_unit_id: "u-204",
    is_house_account: false,
    due_now: 263.77,
    due_date: "2026-08-06",
    ...over,
  };
}

function bill(over = {}) {
  return {
    id: "b-1",
    mlgw_account_id: "acct-1",
    document_id: "SAMPLE-1",
    is_current: true,
    bill_date: "2026-07-16",
    due_date: "2026-08-06",
    amount_due: 263.77,
    balance_forward: 0,
    bill_for: "Xela Capital LLC",
    file_path: "",
    gas_total: 6.92,
    electric_total: 155,
    water_total: 31.93,
    sewer_total: 0,
    other_mlgw_total: null,
    non_mlgw_total: null,
    sewer_charge_total: null,
    ...over,
  };
}

test("water bucket folds water + sewer usage + sewer fee", () => {
  assert.equal(waterTotalOf(bill({ water_total: 30, sewer_total: 10, sewer_charge_total: 5 })), 45);
  assert.equal(waterTotalOf(bill({ water_total: null, sewer_total: null, sewer_charge_total: null })), 0);
});

test("new charges floor at zero and ignore negative balance forward", () => {
  assert.equal(newChargesOf({ amount_due: 100, balance_forward: 30 }), 70);
  assert.equal(newChargesOf({ amount_due: 100, balance_forward: -50 }), 100);
  assert.equal(newChargesOf({ amount_due: 20, balance_forward: 80 }), 0);
});

test("charge segments keep the mockup's order and drop zeros", () => {
  const segs = chargeSegmentsOf(bill({ balance_forward: 10, other_mlgw_total: 2 }));
  assert.deepEqual(segs.map((s) => s.key), ["balfwd", "gas", "electric", "water", "other"]);
});

test("monthly series zero-fills the full 12-month axis", () => {
  const series = monthlySpendSeries([bill(), bill({ id: "b-2", bill_date: "2026-05-16", amount_due: 100 })], NOW);
  assert.equal(series.length, 12);
  assert.equal(series[0].month, "2025-08");
  assert.equal(series.at(-1).month, "2026-07");
  assert.equal(series.at(-1).total, 263.77);
  assert.equal(series.find((p) => p.month === "2026-05").total, 100);
  assert.equal(series.find((p) => p.month === "2026-01").total, 0);
});

test("monthly series carries per-service sums for the hover callout", () => {
  const series = monthlySpendSeries([bill(), bill({ id: "b-2", electric_total: 45 })], NOW);
  const jul = series.at(-1);
  assert.equal(jul.services.electric, 200); // 155 + 45
  assert.equal(jul.services.water, 63.86); // 2 × 31.93
  assert.equal(jul.services.gas, 13.84);
  assert.equal(jul.services.other, 0);
  // Empty months carry a zeroed service map, not undefined.
  assert.deepEqual(series.find((p) => p.month === "2026-01").services.electric, 0);
});

test("fee items itemize nonzero fees and expose the unclassified remainder", () => {
  const rich = bill({
    other_mlgw_total: 50,
    street_light_fee_total: 4.3,
    storm_water_fee_total: 12.15,
    solid_waste_fee_total: 30,
  });
  const items = feeItemsOf(rich);
  assert.deepEqual(items.map((f) => f.label), [
    "Street light fee",
    "Storm water fee",
    "Solid waste fee",
    "Unclassified",
  ]);
  assert.equal(items.at(-1).amount, 3.55); // 50 − 46.45 itemized
  // No fees at all → empty (no zero-noise rows, no negative remainder).
  assert.deepEqual(feeItemsOf(bill()), []);
  const overItemized = bill({ other_mlgw_total: 10, solid_waste_fee_total: 30 });
  assert.deepEqual(feeItemsOf(overItemized).map((f) => f.label), ["Solid waste fee"]);
});

test("current month mix splits units vs house on the latest current month", () => {
  const accounts = [account(), account({ id: "acct-h", is_house_account: true })];
  const mix = currentMonthMix(accounts, [
    bill(),
    bill({ id: "b-h", mlgw_account_id: "acct-h", amount_due: 500, electric_total: 400, water_total: 90, gas_total: 10 }),
    bill({ id: "b-old", is_current: false, bill_date: "2026-06-16" }),
  ]);
  assert.equal(mix.month, "2026-07");
  assert.equal(mix.units.billCount, 1);
  assert.equal(mix.house.billCount, 1);
  assert.equal(mix.house.total, 500);
  const elec = mix.units.segments.find((s) => s.key === "electric");
  assert.ok(elec.share > 0.7 && elec.share < 0.9);
});

test("month over month compares the two newest bill months and flags vacancy", () => {
  const accounts = [account(), account({ id: "acct-2", resman_unit_id: "u-105" })];
  const bills = [
    bill(),
    bill({ id: "b-2", mlgw_account_id: "acct-2", amount_due: 100, electric_total: 60 }),
    bill({ id: "b-p1", is_current: false, bill_date: "2026-06-16", amount_due: 200, electric_total: 120 }),
  ];
  const mom = monthOverMonth(accounts, bills, new Set(["u-105"]));
  assert.equal(mom.currentMonth, "2026-07");
  assert.equal(mom.previousMonth, "2026-06");
  assert.equal(mom.totalSpend.current, 363.77);
  assert.equal(mom.totalSpend.previous, 200);
  assert.equal(mom.vacancyExposure.billCount, 1);
  assert.equal(mom.vacancyExposure.total, 100);
  // Percent guard: previous 0 → null pct.
  const momNoPrev = monthOverMonth(accounts, [bill()], new Set());
  assert.equal(momNoPrev.totalSpend.pct, null);
});

test("account summaries carry XMS's displayDueNow rule and status flags", () => {
  const rows = accountSummaries(
    [account(), account({ id: "acct-2", due_now: 50, due_date: "2026-07-10" })],
    [bill(), bill({ id: "b-2", mlgw_account_id: "acct-2", amount_due: 50, due_date: "2026-07-10" })],
    NOW,
  );
  assert.equal(rows[0].dueNow, 263.77); // account.due_now preferred
  assert.equal(rows[0].pastDue, false);
  assert.equal(rows[1].pastDue, true); // Jul 10 < Jul 21
  assert.equal(rows[0].billCount, 1);
  assert.ok(rows[0].segments.length >= 3);
});

test("exceptions: high electrical over the absolute threshold, after-move-in, review join", () => {
  const facts = new Map([
    ["u-204", { resman_unit_id: "u-204", unit_number: "204", occupancy_status: "Occupied", tenant_names: ["Sofia"],
                move_in_date: "2026-05-24", move_out_date: null, lease_start_date: "2026-05-24", lease_end_date: "2027-05-24" }],
  ]);
  const found = detectExceptions([account()], [bill()], facts, new Set(["b-1|billed_after_move_in"]));
  const kinds = found.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["billed_after_move_in", "high_electrical"]);
  assert.ok(bill().electric_total >= HIGH_ELECTRIC_ABSOLUTE);
  const afterMoveIn = found.find((e) => e.kind === "billed_after_move_in");
  assert.equal(afterMoveIn.reviewed, true); // joined against the review key
  const high = found.find((e) => e.kind === "high_electrical");
  assert.equal(high.reviewed, false);
  assert.match(high.metricLine, /vs threshold \$150/);
  // Reviewed sorts after unreviewed.
  assert.equal(found[0].kind, "high_electrical");
});

test("exceptions: house accounts never flag electrical/spike; moved-out tenants don't flag", () => {
  const houseBill = bill({ id: "b-h", mlgw_account_id: "acct-h", electric_total: 900 });
  const facts = new Map([
    ["u-204", { resman_unit_id: "u-204", unit_number: "204", occupancy_status: "Vacant", tenant_names: [],
                move_in_date: "2026-01-01", move_out_date: "2026-06-01", lease_start_date: null, lease_end_date: null }],
  ]);
  const found = detectExceptions(
    [account({ id: "acct-h", is_house_account: true }), account()],
    [houseBill, bill()],
    facts,
    new Set(),
  );
  assert.equal(found.filter((e) => e.accountId === "acct-h").length, 0);
  // Bill (Jul 16) after move-out (Jun 1) → no after-move-in flag.
  assert.equal(found.filter((e) => e.kind === "billed_after_move_in").length, 0);
});

test("ledger tree pairs payments to their bill window and reconciles balance forward", () => {
  const bills = [
    bill({ id: "b-jun", is_current: false, bill_date: "2026-06-16", amount_due: 235.49, balance_forward: 0 }),
    bill({ id: "b-jul", bill_date: "2026-07-16", amount_due: 263.77, balance_forward: 0 }),
  ];
  const payments = [
    { id: "p-1", mlgw_account_id: "acct-1", reference_number: "000204202606", status: "Processed",
      amount: 235.49, paid_date: "2026-07-04", payment_method: "Credit Card", authorization_number: "258499" },
  ];
  const tree = buildLedgerTree(bills, payments);
  assert.equal(tree[0].bill.id, "b-jul");
  assert.equal(tree[0].isLatest, true);
  assert.equal(tree[0].payments.length, 0);
  assert.equal(tree[0].reconciles, null); // latest has no newer bill to check
  assert.equal(tree[1].payments.length, 1); // Jul 4 payment ∈ [Jun 16, Jul 16)
  assert.equal(tree[1].paidBeforeNext, 235.49);
  assert.equal(tree[1].reconciles, true); // fully paid → next balance_forward 0 ✓
});

test("bill detail stats: average, highest, previous delta, after-move-in rollup", () => {
  const bills = [
    bill(),
    bill({ id: "b-jun", is_current: false, bill_date: "2026-06-16", amount_due: 235.49 }),
    bill({ id: "b-may", is_current: false, bill_date: "2026-05-16", amount_due: 219.99 }),
  ];
  const facts = { resman_unit_id: "u-204", unit_number: "204", occupancy_status: "Occupied", tenant_names: ["Sofia"],
                  move_in_date: "2026-05-24", move_out_date: null, lease_start_date: "2026-05-24", lease_end_date: "2027-05-24" };
  const stats = billDetailStats(bills, bills[0], facts);
  assert.equal(stats.amountRecords, 3);
  assert.equal(stats.highest.amount, 263.77);
  assert.equal(stats.previousDelta.delta, 28.28);
  assert.equal(stats.afterMoveIn.billCount, 2); // Jun + Jul bills post 5/24
  assert.equal(stats.afterMoveIn.total, 499.26);
});

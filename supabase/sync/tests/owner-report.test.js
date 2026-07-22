/**
 * Owner-report unit tests — the pure seams only, no Supabase and no Chromium:
 *
 *   figures.ts  — period windows, null-safe MoM deltas (the "series began"
 *                 honesty rule), the missing-renewals-table contract, and the
 *                 per-block derivations.
 *   template.ts — KPI values present, null blocks omitted, self-contained
 *                 (no external URLs).
 *   store.ts    — storage naming (<YYYY-MM>.pdf/.html/.json in owner-reports).
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildReportFigures,
  isValidReportPeriod,
  previousCalendarMonth,
  reportPeriodOf,
  trailingMonths,
} = require("../src/reports/figures.ts");
const { renderOwnerReportHtml } = require("../src/reports/template.ts");
const { OWNER_REPORTS_BUCKET, ownerReportPaths } = require("../src/reports/store.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERIOD = reportPeriodOf("2026-07");

function unit(overrides = {}) {
  return {
    resman_unit_id: "unit-1",
    number: "0101",
    occupied: true,
    holding_unit: false,
    excluded_from_occupancy: false,
    market_rent: 1300,
    lease_rent: 1200,
    balance: 0,
    current_month_balance: null,
    last_month_balance: null,
    period_balance: null,
    previous_balance: null,
    delinquency_reason: "",
    ...overrides,
  };
}

function lease(overrides = {}) {
  return {
    unit_number: "0101",
    application_date: null,
    signed_date: null,
    move_in_date: null,
    move_out_date: null,
    resident_rent: null,
    is_current_lease: false,
    ...overrides,
  };
}

function workOrder(overrides = {}) {
  return {
    resman_work_order_id: "wo-1",
    unit_number: "0101",
    status: "Completed",
    priority: "Normal",
    is_make_ready: false,
    date_reported: "2026-07-02",
    date_completed: "2026-07-05",
    callback_status: "none",
    ...overrides,
  };
}

function snapshotDay(overrides = {}) {
  return {
    snapshot_date: "2026-07-31",
    occupancy_pct: 92.4,
    balance_total: 48200,
    total_units: 878,
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    period: PERIOD,
    generatedAt: "2026-08-01T06:00:00.000Z",
    propertyName: "Emberly Apartments",
    units: [],
    leases: [],
    transactions: [],
    workOrders: [],
    bills: [],
    pmTasks: [],
    delinquencyActions: [],
    snapshots: [],
    renewalOffers: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Period math
// ---------------------------------------------------------------------------

test("isValidReportPeriod accepts YYYY-MM with a real month only", () => {
  assert.equal(isValidReportPeriod("2026-07"), true);
  assert.equal(isValidReportPeriod("2026-12"), true);
  assert.equal(isValidReportPeriod("2026-00"), false);
  assert.equal(isValidReportPeriod("2026-13"), false);
  assert.equal(isValidReportPeriod("2026-7"), false);
  assert.equal(isValidReportPeriod("2026-07-01"), false);
  assert.equal(isValidReportPeriod("garbage"), false);
});

test("reportPeriodOf expands the window, leap-safe, with prior month", () => {
  const july = reportPeriodOf("2026-07");
  assert.equal(july.startDate, "2026-07-01");
  assert.equal(july.endDate, "2026-07-31");
  assert.equal(july.nextStartDate, "2026-08-01");
  assert.equal(july.priorPeriod, "2026-06");
  assert.equal(july.priorEndDate, "2026-06-30");
  assert.equal(july.label, "July 2026");

  const january = reportPeriodOf("2026-01");
  assert.equal(january.priorPeriod, "2025-12");
  assert.equal(january.priorEndDate, "2025-12-31");

  const leapFeb = reportPeriodOf("2028-02");
  assert.equal(leapFeb.endDate, "2028-02-29");

  const december = reportPeriodOf("2026-12");
  assert.equal(december.nextStartDate, "2027-01-01");

  assert.throws(() => reportPeriodOf("2026-7"));
});

test("previousCalendarMonth uses the property time zone and rolls the year", () => {
  // 2026-01-01T03:00Z is still Dec 31 in Chicago — the "previous month" for a
  // run just after midnight UTC must be November, not December.
  assert.equal(previousCalendarMonth(new Date("2026-01-01T03:00:00Z"), "America/Chicago"), "2025-11");
  // Same instant in UTC: Jan 1 → previous month December.
  assert.equal(previousCalendarMonth(new Date("2026-01-01T03:00:00Z"), "UTC"), "2025-12");
  assert.equal(previousCalendarMonth(new Date("2026-08-01T12:00:00Z"), "America/Chicago"), "2026-07");
});

test("trailingMonths ends at the period, oldest first", () => {
  assert.deepEqual(trailingMonths("2026-02", 3), ["2025-12", "2026-01", "2026-02"]);
  assert.equal(trailingMonths("2026-07", 12)[0], "2025-08");
  assert.equal(trailingMonths("2026-07", 12).at(-1), "2026-07");
});

// ---------------------------------------------------------------------------
// Figures — deltas + honesty rules
// ---------------------------------------------------------------------------

test("MoM deltas come from the two month-end snapshots", () => {
  const figures = buildReportFigures(
    baseInput({
      snapshots: [
        snapshotDay({ snapshot_date: "2026-06-15", occupancy_pct: 90.0, balance_total: 60000 }),
        snapshotDay({ snapshot_date: "2026-06-30", occupancy_pct: 91.3, balance_total: 54300 }),
        snapshotDay({ snapshot_date: "2026-07-30", occupancy_pct: 92.0, balance_total: 50000 }),
        snapshotDay({ snapshot_date: "2026-07-31", occupancy_pct: 92.4, balance_total: 48200 }),
      ],
    }),
  );
  // Month end (Jul 31) vs prior month end (Jun 30) — mid-month rows ignored.
  assert.equal(figures.occupancy.pct, 92.4);
  assert.equal(figures.occupancy.momDeltaPts, 1.1);
  assert.equal(figures.delinquency.momDelta, -6100);
});

test("fewer than two months of snapshots → deltas omitted, not faked", () => {
  const figures = buildReportFigures(
    baseInput({
      units: [unit()],
      snapshots: [snapshotDay({ snapshot_date: "2026-07-31" })],
    }),
  );
  assert.equal(figures.occupancy.momDeltaPts, null);
  assert.equal(figures.delinquency.momDelta, null);
  // The month's own numbers still stand.
  assert.equal(figures.occupancy.pct, 92.4);
});

test("no snapshots at all: occupancy falls back to the mirror fold", () => {
  const figures = buildReportFigures(
    baseInput({ units: [unit(), unit({ resman_unit_id: "unit-2", number: "0102", occupied: false })] }),
  );
  assert.equal(figures.occupancy.pct, 50);
  assert.equal(figures.occupancy.totalUnits, 2);
  assert.equal(figures.occupancy.momDeltaPts, null);
  assert.equal(figures.property.totalUnits, 2);
});

test("renewalOffers null (table missing) → renewals block null; rows → counted", () => {
  const without = buildReportFigures(baseInput({ renewalOffers: null }));
  assert.equal(without.leasing.renewals, null);

  const withOffers = buildReportFigures(
    baseInput({
      renewalOffers: [
        { outcome: "accepted", sent_at: "2026-07-01", responded_at: "2026-07-14" },
        { outcome: "accepted", sent_at: "2026-05-01", responded_at: "2026-06-02" }, // prior period
        { outcome: null, sent_at: "2026-07-10", responded_at: null },
        { outcome: "pending", sent_at: "2026-07-16", responded_at: null },
        { outcome: "declined", sent_at: "2026-07-03", responded_at: "2026-07-20" },
        { outcome: null, sent_at: null, responded_at: null }, // never sent
      ],
    }),
  );
  assert.deepEqual(withOffers.leasing.renewals, { accepted: 1, offersOut: 2 });
});

// ---------------------------------------------------------------------------
// Figures — period-window derivations
// ---------------------------------------------------------------------------

test("collections sums the period's charges/credits; empty ledger → nulls", () => {
  const figures = buildReportFigures(
    baseInput({
      transactions: [
        { date: "2026-07-01", charges: 1000, credits: 0 },
        { date: "2026-07-15", charges: 310, credits: 940 },
        { date: "2026-06-30", charges: 99999, credits: 99999 }, // outside window
        { date: null, charges: 5, credits: 5 },
      ],
    }),
  );
  assert.equal(figures.collections.billed, 1310);
  assert.equal(figures.collections.collected, 940);
  assert.equal(figures.collections.ratePct, 71.76);

  const empty = buildReportFigures(baseInput());
  assert.deepEqual(empty.collections, { billed: null, collected: null, ratePct: null });
});

test("leasing counts window on the lease dates; avg signed rent needs a rent", () => {
  const figures = buildReportFigures(
    baseInput({
      leases: [
        lease({ move_in_date: "2026-07-03" }),
        lease({ move_in_date: "2026-08-01" }), // next month
        lease({ move_out_date: "2026-07-30" }),
        lease({ application_date: "2026-07-11" }),
        lease({ signed_date: "2026-07-09", resident_rent: 1400 }),
        lease({ signed_date: "2026-07-21", resident_rent: 1484 }),
        lease({ signed_date: "2026-07-22", resident_rent: null }), // no rent → excluded
      ],
    }),
  );
  assert.equal(figures.leasing.moveIns, 1);
  assert.equal(figures.leasing.moveOuts, 1);
  assert.equal(figures.leasing.applications, 1);
  assert.equal(figures.leasing.avgSignedRent, 1442);
});

test("loss to lease annualizes market-minus-in-place over occupied units", () => {
  const figures = buildReportFigures(
    baseInput({
      units: [
        unit({ market_rent: 1300, lease_rent: 1200 }),                              // +100
        unit({ resman_unit_id: "u2", number: "0102", market_rent: 1400, lease_rent: 1350 }), // +50
        unit({ resman_unit_id: "u3", number: "0103", occupied: false }),            // vacant — excluded
        unit({ resman_unit_id: "u4", number: "0104", lease_rent: null }),           // underivable — excluded
      ],
    }),
  );
  assert.equal(figures.leasing.lossToLeasePerYear, 150 * 12);

  const bare = buildReportFigures(baseInput({ units: [unit({ lease_rent: null })] }));
  assert.equal(bare.leasing.lossToLeasePerYear, null);
});

test("aging buckets count units and clamp balances like the snapshot fold", () => {
  const figures = buildReportFigures(
    baseInput({
      units: [
        unit({ balance: 500, current_month_balance: 300, last_month_balance: 200 }),
        unit({ resman_unit_id: "u2", number: "0102", balance: 900, current_month_balance: 100, previous_balance: 800 }),
        unit({ resman_unit_id: "u3", number: "0103", balance: -40, current_month_balance: 40 }), // credit — ignored
      ],
    }),
  );
  assert.deepEqual(figures.delinquency.aging, [
    { bucket: "0-30", units: 2, balance: 400 },
    { bucket: "31-60", units: 1, balance: 200 },
    { bucket: "61-90", units: 0, balance: 0 },
    { bucket: "90+", units: 1, balance: 800 },
  ]);
  assert.equal(figures.delinquency.total, 1400);
});

test("delinquency actions fold to notices/promises/FED; none → null", () => {
  const figures = buildReportFigures(
    baseInput({
      delinquencyActions: [
        { kind: "notice_served", created_at: "2026-07-02T15:00:00Z" },
        { kind: "notice_served", created_at: "2026-07-20T15:00:00Z" },
        { kind: "promise_recorded", created_at: "2026-07-09T15:00:00Z" },
        { kind: "fed_filed", created_at: "2026-07-28T15:00:00Z" },
        { kind: "called", created_at: "2026-07-28T15:00:00Z" },          // other kind
        { kind: "notice_served", created_at: "2026-06-28T15:00:00Z" },   // prior month
      ],
    }),
  );
  assert.deepEqual(figures.delinquency.actions, { notices: 2, promises: 1, fedFilings: 1 });
  assert.equal(buildReportFigures(baseInput()).delinquency.actions, null);
});

test("utility spend uses component totals and compares the two billed months", () => {
  const bill = (overrides) => ({
    bill_date: "2026-07-10",
    amount_due: null,
    balance_forward: null,
    gas_total: null,
    electric_total: null,
    water_total: null,
    sewer_total: null,
    other_mlgw_total: null,
    ...overrides,
  });
  const figures = buildReportFigures(
    baseInput({
      bills: [
        bill({ gas_total: 200, electric_total: 300 }),
        bill({ amount_due: 550, balance_forward: 50 }), // no components → due minus forward
        bill({ bill_date: "2026-06-12", electric_total: 900 }),
        bill({ bill_date: "2026-06-20", amount_due: 100 }),
      ],
    }),
  );
  assert.equal(figures.utilities.spend, 1000);
  assert.equal(figures.utilities.momDeltaPct, 0);

  const oneMonth = buildReportFigures(baseInput({ bills: [bill({ gas_total: 700 })] }));
  assert.equal(oneMonth.utilities.spend, 700);
  assert.equal(oneMonth.utilities.momDeltaPct, null);
});

test("turns: completed vs in-progress vs late, avg days, vacancy cost", () => {
  const figures = buildReportFigures(
    baseInput({
      units: [unit({ number: "0101", market_rent: 1460 })], // 1460*12/365 = $48/day
      leases: [
        // Pending move-in on the in-progress unit, date already passed → late.
        lease({ unit_number: "0202", move_in_date: "2026-07-25", is_current_lease: false }),
      ],
      workOrders: [
        // Unit 0101: turn fully completed inside July (Jul 2 → Jul 7 = 5 days).
        workOrder({ resman_work_order_id: "mr-1", is_make_ready: true, date_reported: "2026-07-02", date_completed: "2026-07-05" }),
        workOrder({ resman_work_order_id: "mr-2", is_make_ready: true, date_reported: "2026-07-03", date_completed: "2026-07-07" }),
        // Unit 0202: still open → in progress (and late, per the lease above).
        workOrder({ resman_work_order_id: "mr-3", unit_number: "0202", is_make_ready: true, status: "In Progress", date_completed: null }),
        // Unit 0303: completed in June — outside the period.
        workOrder({ resman_work_order_id: "mr-4", unit_number: "0303", is_make_ready: true, date_reported: "2026-06-01", date_completed: "2026-06-20" }),
      ],
    }),
  );
  assert.equal(figures.turns.completed, 1);
  assert.equal(figures.turns.inProgress, 1);
  assert.equal(figures.turns.lateForMoveIn, 1);
  assert.equal(figures.turns.avgDaysInTurn, 5);
  assert.equal(figures.turns.vacancyCost, 240); // 5 days × $48/day

  // No market rent for the completed unit → vacancy cost omitted, not zeroed.
  const noMarket = buildReportFigures(
    baseInput({
      workOrders: [
        workOrder({ resman_work_order_id: "mr-1", unit_number: "0909", is_make_ready: true }),
      ],
    }),
  );
  assert.equal(noMarket.turns.completed, 1);
  assert.equal(noMarket.turns.vacancyCost, null);
});

test("maintenance: closed/emergencies/callback rate/PM, all period-scoped", () => {
  const figures = buildReportFigures(
    baseInput({
      workOrders: [
        workOrder({ resman_work_order_id: "w1" }),
        workOrder({ resman_work_order_id: "w2", status: "Closed", date_completed: "2026-07-30" }),
        workOrder({ resman_work_order_id: "w3", status: "Canceled", date_completed: "2026-07-12" }), // not "closed" work
        workOrder({ resman_work_order_id: "w4", priority: "Emergency", status: "In Progress", date_completed: null }),
        workOrder({ resman_work_order_id: "w5", callback_status: "confirmed" }),
        workOrder({ resman_work_order_id: "w6", date_reported: "2026-06-10", date_completed: "2026-07-01" }), // reported before period
      ],
      pmTasks: [
        { round_key: "2026-07", status: "done", due_date: "2026-07-15", completed_at: "2026-07-10T12:00:00Z" },
        { round_key: "2026-07", status: "done", due_date: "2026-07-15", completed_at: "2026-07-20T12:00:00Z" }, // late
        { round_key: "2026-07", status: "pending", due_date: "2026-07-15", completed_at: null },
        { round_key: "2026-06", status: "done", due_date: "2026-06-15", completed_at: "2026-06-10T12:00:00Z" }, // other round
      ],
    }),
  );
  assert.equal(figures.maintenance.closed, 4); // w1, w2, w5, w6
  assert.equal(figures.maintenance.emergencies, 1);
  // Reported in period: w1..w5 (5 of them); one confirmed callback → 20%.
  assert.equal(figures.maintenance.callbackRatePct, 20);
  assert.deepEqual(figures.maintenance.preventive, { completed: 2, total: 3, onTime: 1 });

  const quiet = buildReportFigures(baseInput());
  assert.equal(quiet.maintenance.callbackRatePct, null);
  assert.equal(quiet.maintenance.preventive, null);
});

test("occupancy series carries 12 months with honest nulls before the series began", () => {
  const figures = buildReportFigures(
    baseInput({
      snapshots: [
        snapshotDay({ snapshot_date: "2026-06-30", occupancy_pct: 91.3 }),
        snapshotDay({ snapshot_date: "2026-07-31", occupancy_pct: 92.4 }),
      ],
    }),
  );
  assert.equal(figures.occupancySeries.length, 12);
  assert.deepEqual(figures.occupancySeries.at(-1), { month: "2026-07", occupancyPct: 92.4 });
  assert.deepEqual(figures.occupancySeries.at(-2), { month: "2026-06", occupancyPct: 91.3 });
  assert.equal(figures.occupancySeries[0].month, "2025-08");
  assert.equal(figures.occupancySeries[0].occupancyPct, null);
});

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

function richFigures() {
  return buildReportFigures(
    baseInput({
      units: [
        unit({ balance: 500, current_month_balance: 500 }),
        unit({ resman_unit_id: "u2", number: "0102", market_rent: 1400, lease_rent: 1350 }),
      ],
      leases: [lease({ signed_date: "2026-07-09", resident_rent: 1442 })],
      transactions: [{ date: "2026-07-15", charges: 1310000, credits: 1240000 }],
      bills: [
        { bill_date: "2026-07-10", amount_due: 9800, balance_forward: 0, gas_total: null, electric_total: null, water_total: null, sewer_total: null, other_mlgw_total: null },
      ],
      snapshots: [
        snapshotDay({ snapshot_date: "2026-06-30", occupancy_pct: 91.3, balance_total: 54300 }),
        snapshotDay({ snapshot_date: "2026-07-31", occupancy_pct: 92.4, balance_total: 48200 }),
      ],
      renewalOffers: [{ outcome: "accepted", sent_at: "2026-07-01", responded_at: "2026-07-10" }],
      pmTasks: [{ round_key: "2026-07", status: "done", due_date: "2026-07-15", completed_at: "2026-07-10T12:00:00Z" }],
    }),
  );
}

test("template renders the KPI values, header, and spec'd footer", () => {
  const html = renderOwnerReportHtml(richFigures());
  assert.match(html, /Emberly Apartments — Monthly Report/);
  assert.match(html, /July 2026/);
  assert.match(html, /92\.4%/);                       // occupancy KPI
  assert.match(html, /▲ 1\.1 pt MoM/);                // occupancy delta
  assert.match(html, /94\.7%/);                       // collections rate
  assert.match(html, /\$1\.24M of \$1\.31M/);         // collections detail
  assert.match(html, /▼ \$6\.1k MoM/);                // delinquency delta (down = good)
  assert.match(html, /\$9\.8k/);                      // utility spend
  assert.match(html, /\$1,442/);                      // avg signed rent
  assert.match(html, /1 \/ 1/);                       // renewals accepted / offers out
  assert.match(html, /Generated Aug 1, 2026 · Emberly sync worker · figures from ResMan \+ MLGW as synced/);
  assert.match(html, /Page 1 of 2/);
  assert.match(html, /@page \{ size: Letter; \}/);
  assert.match(html, /<polyline/);                    // occupancy series charted
});

test("template omits null blocks instead of faking them", () => {
  const html = renderOwnerReportHtml(buildReportFigures(baseInput()));
  assert.doesNotMatch(html, /Renewals accepted/);
  assert.doesNotMatch(html, /Avg lease rent signed/);
  assert.doesNotMatch(html, /Loss to lease/);
  assert.doesNotMatch(html, /Vacancy cost/);
  assert.doesNotMatch(html, /Avg days in turn/);
  assert.doesNotMatch(html, /Callback rate/);
  assert.doesNotMatch(html, /Preventive tasks/);
  assert.doesNotMatch(html, /Delinquency aging/);
  assert.doesNotMatch(html, /Actions this month/);
  assert.doesNotMatch(html, /MoM</);                  // no deltas anywhere
  assert.doesNotMatch(html, /<polyline/);             // series too short to chart
  assert.match(html, /monthly snapshots accrue/);     // …and says so honestly
});

test("template is fully self-contained — no external references", () => {
  for (const html of [renderOwnerReportHtml(richFigures()), renderOwnerReportHtml(buildReportFigures(baseInput()))]) {
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<link/);
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /src=/);
    assert.doesNotMatch(html, /@import/);
    assert.doesNotMatch(html, /url\(/);
  }
});

test("template escapes figure-borne strings", () => {
  const figures = richFigures();
  figures.property.name = `<img src=x> & "quotes"`;
  const html = renderOwnerReportHtml(figures);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x&gt; &amp; &quot;quotes&quot;/);
});

// ---------------------------------------------------------------------------
// Storage naming
// ---------------------------------------------------------------------------

test("owner-report objects are period-stamped in the owner-reports bucket", () => {
  assert.equal(OWNER_REPORTS_BUCKET, "owner-reports");
  assert.deepEqual(ownerReportPaths("2026-07"), {
    pdf: "2026-07.pdf",
    html: "2026-07.html",
    json: "2026-07.json",
  });
});

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPropertySnapshot,
  countsForOccupancy,
  isDelinquentUnit,
  isOpenWorkOrder,
  propertySnapshotDate,
} = require("../src/snapshots/build.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function workOrder(overrides = {}) {
  return {
    unit_number: "0101",
    status: "In Progress",
    is_make_ready: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Membership rules mirrored from the apps
// ---------------------------------------------------------------------------

test("countsForOccupancy drops holding and occupancy-excluded units", () => {
  assert.equal(countsForOccupancy({ excluded_from_occupancy: false, holding_unit: false }), true);
  assert.equal(countsForOccupancy({ excluded_from_occupancy: null, holding_unit: null }), true);
  assert.equal(countsForOccupancy({ excluded_from_occupancy: true, holding_unit: false }), false);
  assert.equal(countsForOccupancy({ excluded_from_occupancy: false, holding_unit: true }), false);
});

test("isDelinquentUnit: positive balance or a non-blank reason", () => {
  assert.equal(isDelinquentUnit({ balance: 120.5, delinquency_reason: "" }), true);
  assert.equal(isDelinquentUnit({ balance: 0, delinquency_reason: "Under eviction" }), true);
  assert.equal(isDelinquentUnit({ balance: 0, delinquency_reason: "  " }), false);
  assert.equal(isDelinquentUnit({ balance: -35, delinquency_reason: null }), false);
  assert.equal(isDelinquentUnit({ balance: null, delinquency_reason: null }), false);
});

test("isOpenWorkOrder: only terminal statuses count as closed", () => {
  for (const status of ["Not Started", "Scheduled", "In Progress", "", null]) {
    assert.equal(isOpenWorkOrder({ status }), true, String(status));
  }
  for (const status of ["Completed", "Closed", "Canceled"]) {
    assert.equal(isOpenWorkOrder({ status }), false, status);
  }
});

test("propertySnapshotDate stamps the property's calendar day, not UTC's", () => {
  // 03:30 UTC on July 22 is still July 21 in Memphis (UTC-5 in July).
  const lateNightUtc = new Date("2026-07-22T03:30:00.000Z");
  assert.equal(propertySnapshotDate(lateNightUtc, "America/Chicago"), "2026-07-21");
  assert.equal(propertySnapshotDate(lateNightUtc, "UTC"), "2026-07-22");
});

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

test("buildPropertySnapshot folds the mirror into one dated row", () => {
  const units = [
    // Occupied, current on rent.
    unit(),
    // Occupied and delinquent across three buckets.
    unit({
      resman_unit_id: "unit-2",
      number: "0102",
      market_rent: 1400,
      lease_rent: 1350,
      balance: 620.5,
      current_month_balance: 300,
      last_month_balance: 120.5,
      period_balance: 200,
      previous_balance: -10, // credits inside a column never subtract
    }),
    // Vacant.
    unit({ resman_unit_id: "unit-3", number: "0103", occupied: false, lease_rent: null }),
    // Reason-only delinquency (zero balance): counts as delinquent, adds no $.
    unit({
      resman_unit_id: "unit-4",
      number: "0104",
      balance: 0,
      delinquency_reason: "Under eviction",
    }),
    // Holding unit: out of occupancy AND rent totals, but its balance still counts.
    unit({
      resman_unit_id: "unit-5",
      number: "OFFICE",
      holding_unit: true,
      market_rent: 999,
      lease_rent: 999,
      balance: 50,
      current_month_balance: 50,
    }),
    // Excluded from occupancy.
    unit({ resman_unit_id: "unit-6", number: "MODEL", excluded_from_occupancy: true }),
  ];
  const workOrders = [
    // Two open make-ready orders on the same unit → one turn.
    workOrder({ unit_number: "0103", is_make_ready: true }),
    workOrder({ unit_number: "0103", is_make_ready: true, status: "Scheduled" }),
    // A second turn on another unit.
    workOrder({ unit_number: "0104", is_make_ready: true, status: "Not Started" }),
    // A closed make-ready order is not a turn (and not open).
    workOrder({ unit_number: "0101", is_make_ready: true, status: "Completed" }),
    // A regular open order counts toward open_work_orders only.
    workOrder({ unit_number: "0101" }),
  ];
  const utilityAccounts = [{ due_now: 120.25 }, { due_now: null }, { due_now: 30 }];

  const row = buildPropertySnapshot({
    units,
    workOrders,
    utilityAccounts,
    snapshotDate: "2026-07-22",
  });

  assert.deepEqual(row, {
    snapshot_date: "2026-07-22",
    // Counted: unit-1..4 (holding + excluded dropped). Occupied: 1, 2, 4.
    total_units: 4,
    occupied_units: 3,
    vacant_units: 1,
    occupancy_pct: 75,
    rent_roll: 1300 + 1400 + 1300 + 1300,
    lease_rent_total: 1200 + 1350 + 1200, // occupied counted units only
    balance_total: 670.5, // 620.50 + 50 (holding unit's balance still counts)
    balance_0_30: 350, // 300 + 50
    balance_31_60: 120.5,
    balance_61_90: 200,
    balance_90_plus: 0, // negative column clamped
    delinquent_units: 3, // unit-2 ($), unit-4 (reason), unit-5 ($)
    turns_in_progress: 2, // 0103 (deduped) + 0104
    open_work_orders: 4,
    utility_due: 150.25,
    source: "nightly",
  });
});

test("buildPropertySnapshot: empty mirror yields a null occupancy pct, zeros elsewhere", () => {
  const row = buildPropertySnapshot({
    units: [],
    workOrders: [],
    utilityAccounts: [],
    snapshotDate: "2026-07-22",
  });
  assert.equal(row.total_units, 0);
  assert.equal(row.occupancy_pct, null);
  assert.equal(row.balance_total, 0);
  assert.equal(row.turns_in_progress, 0);
  assert.equal(row.utility_due, 0);
});

test("buildPropertySnapshot rounds money columns to cents", () => {
  const row = buildPropertySnapshot({
    units: [
      unit({ balance: 100.105, current_month_balance: 100.105, market_rent: 0.115, lease_rent: 0.115 }),
    ],
    workOrders: [],
    utilityAccounts: [{ due_now: 0.105 }],
    snapshotDate: "2026-07-22",
  });
  assert.equal(row.balance_total, 100.11);
  assert.equal(row.balance_0_30, 100.11);
  assert.equal(row.utility_due, 0.11);
  assert.equal(row.rent_roll, 0.12);
});

test("blank-unit make-ready orders pool into one Unassigned turn", () => {
  const row = buildPropertySnapshot({
    units: [],
    workOrders: [
      workOrder({ unit_number: "", is_make_ready: true }),
      workOrder({ unit_number: null, is_make_ready: true }),
    ],
    utilityAccounts: [],
    snapshotDate: "2026-07-22",
  });
  assert.equal(row.turns_in_progress, 1);
  assert.equal(row.open_work_orders, 2);
});

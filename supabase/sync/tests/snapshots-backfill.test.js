const assert = require("node:assert/strict");
const test = require("node:test");

const { buildOccupancyBackfill, leaseOccupancySpan } = require("../src/snapshots/backfill.ts");

function lease(overrides = {}) {
  return {
    resman_unit_id: "unit-1",
    unit_number: "0101",
    status: "Current",
    approval_status: "Approved",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    move_in_date: null,
    move_out_date: null,
    is_current_lease: false,
    ...overrides,
  };
}

/** rows → { date: occupied } for terse assertions. */
function occupiedByDate(rows) {
  return Object.fromEntries(rows.map((r) => [r.snapshot_date, r.occupied_units]));
}

// ---------------------------------------------------------------------------
// Span extraction: the documented date-pair precedence
// ---------------------------------------------------------------------------

test("span precedence: move_in beats start_date; move_out beats end_date", () => {
  const span = leaseOccupancySpan(
    lease({ move_in_date: "2026-01-05", move_out_date: "2026-06-10" }),
  );
  assert.equal(span.startDay * 86_400_000, Date.UTC(2026, 0, 5));
  assert.equal(span.endDay * 86_400_000, Date.UTC(2026, 5, 10));
});

test("span precedence: a CURRENT lease without a move-out is open-ended", () => {
  const span = leaseOccupancySpan(lease({ is_current_lease: true }));
  assert.equal(span.endDay, null);
});

test("span precedence: a non-current lease without a move-out falls back to end_date", () => {
  const span = leaseOccupancySpan(lease());
  assert.equal(span.endDay * 86_400_000, Date.UTC(2026, 11, 31));
});

test("dead, unit-less, undated, and inverted leases produce no span", () => {
  assert.equal(leaseOccupancySpan(lease({ status: "Cancelled" })), null);
  assert.equal(leaseOccupancySpan(lease({ approval_status: "Denied" })), null);
  assert.equal(leaseOccupancySpan(lease({ resman_unit_id: null, unit_number: "  " })), null);
  assert.equal(leaseOccupancySpan(lease({ start_date: null, move_in_date: null })), null);
  assert.equal(
    leaseOccupancySpan(lease({ move_in_date: "2026-06-01", move_out_date: "2026-05-01" })),
    null,
  );
});

test("unit key falls back from resman_unit_id to unit_number", () => {
  assert.equal(leaseOccupancySpan(lease()).unitKey, "unit-1");
  assert.equal(leaseOccupancySpan(lease({ resman_unit_id: null })).unitKey, "0101");
});

// ---------------------------------------------------------------------------
// Daily reconstruction
// ---------------------------------------------------------------------------

test("one row per day across a month boundary, inclusive on both ends", () => {
  const rows = buildOccupancyBackfill({
    leases: [lease({ move_in_date: "2026-01-30", move_out_date: "2026-02-02" })],
    fromDate: "2026-01-29",
    toDate: "2026-02-03",
    totalUnits: 10,
  });
  assert.deepEqual(
    rows.map((r) => r.snapshot_date),
    ["2026-01-29", "2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02", "2026-02-03"],
  );
  assert.deepEqual(occupiedByDate(rows), {
    "2026-01-29": 0,
    "2026-01-30": 1,
    "2026-01-31": 1,
    "2026-02-01": 1,
    "2026-02-02": 1, // move-out day still counts as occupied
    "2026-02-03": 0,
  });
  // Occupancy family only, source 'backfill'.
  assert.deepEqual(rows[1], {
    snapshot_date: "2026-01-30",
    total_units: 10,
    occupied_units: 1,
    vacant_units: 9,
    occupancy_pct: 10,
    source: "backfill",
  });
});

test("open-ended current leases stay occupied through the end of the window", () => {
  const rows = buildOccupancyBackfill({
    leases: [lease({ is_current_lease: true, start_date: "2025-11-15" })],
    fromDate: "2026-07-01",
    toDate: "2026-07-03",
    totalUnits: 4,
  });
  assert.deepEqual(occupiedByDate(rows), {
    "2026-07-01": 1,
    "2026-07-02": 1,
    "2026-07-03": 1,
  });
});

test("overlapping leases on one unit count once per day", () => {
  const rows = buildOccupancyBackfill({
    leases: [
      // Old resident leaves June 10…
      lease({ move_in_date: "2026-01-01", move_out_date: "2026-06-10" }),
      // …renewal rows overlap the same unit entirely.
      lease({ start_date: "2026-06-01", end_date: "2026-12-31" }),
      // A different unit, occupied throughout.
      lease({ resman_unit_id: "unit-2", unit_number: "0102", start_date: "2026-01-01" }),
    ],
    fromDate: "2026-06-09",
    toDate: "2026-06-12",
    totalUnits: 3,
  });
  assert.deepEqual(occupiedByDate(rows), {
    "2026-06-09": 2,
    "2026-06-10": 2,
    "2026-06-11": 2,
    "2026-06-12": 2,
  });
});

test("a gap between one unit's leases reads as vacancy", () => {
  const rows = buildOccupancyBackfill({
    leases: [
      lease({ move_in_date: "2026-01-01", move_out_date: "2026-03-10" }),
      lease({ move_in_date: "2026-03-14", move_out_date: "2026-09-30" }),
    ],
    fromDate: "2026-03-09",
    toDate: "2026-03-15",
    totalUnits: 1,
  });
  assert.deepEqual(occupiedByDate(rows), {
    "2026-03-09": 1,
    "2026-03-10": 1,
    "2026-03-11": 0,
    "2026-03-12": 0,
    "2026-03-13": 0,
    "2026-03-14": 1,
    "2026-03-15": 1,
  });
});

test("occupied is capped at total_units and pct rounds to 2dp", () => {
  const rows = buildOccupancyBackfill({
    leases: [
      lease(),
      lease({ resman_unit_id: "unit-2" }),
      lease({ resman_unit_id: "unit-3" }),
    ],
    fromDate: "2026-02-01",
    toDate: "2026-02-01",
    totalUnits: 2, // lease mirror names more units than the unit mirror carries
  });
  assert.deepEqual(rows, [
    {
      snapshot_date: "2026-02-01",
      total_units: 2,
      occupied_units: 2,
      vacant_units: 0,
      occupancy_pct: 100,
      source: "backfill",
    },
  ]);

  const third = buildOccupancyBackfill({
    leases: [lease()],
    fromDate: "2026-02-01",
    toDate: "2026-02-01",
    totalUnits: 3,
  });
  assert.equal(third[0].occupancy_pct, 33.33);
});

test("an inverted or unparseable window yields nothing", () => {
  assert.deepEqual(
    buildOccupancyBackfill({ leases: [lease()], fromDate: "2026-03-02", toDate: "2026-03-01", totalUnits: 1 }),
    [],
  );
  assert.deepEqual(
    buildOccupancyBackfill({ leases: [lease()], fromDate: "garbage", toDate: "2026-03-01", totalUnits: 1 }),
    [],
  );
});

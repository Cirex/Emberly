const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

// Same bun:test mock.module harness as tests/manager-snapshots.test.js — this
// suite runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = { rows: [] };

function stubClient() {
  const builder = {
    select: () => builder,
    order: () => builder,
    // listResmanUnits pages with .range(); one full page then a short one ends it.
    range: (from, to) => Promise.resolve({ data: state.rows.slice(from, to + 1), error: null }),
  };
  return { from: () => builder };
}

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: stubClient,
  createUntypedAdminClient: stubClient,
  getMissingSupabaseAdminEnvVars: () => [],
}));

mock.module("@/lib/guest-pass-unit-bans", () => ({ purgeExpiredUnitBans: async () => {} }));

const { listResmanUnits } = require("../lib/admin-resman-units");

/**
 * A unit. Defaults are a plain rentable occupied apartment; override what the
 * case is actually about.
 */
function unit(n, over = {}) {
  return {
    resman_unit_id: `u${n}`,
    number: `100${n}`,
    classification: "Ruby",
    occupancy_status: "Occupied",
    occupied: true,
    holding_unit: false,
    excluded_from_occupancy: false,
    lease_status: "Current",
    tenant_names: [],
    bedrooms: 2,
    bathrooms: 1,
    market_rent: 1000,
    lease_rent: 1000,
    balance: 0,
    times_late: 0,
    lease_end_date: null,
    synced_at: "2026-07-31T04:23:00Z",
    ...over,
  };
}

test("a unit on notice counts as occupied — somebody still lives there", async () => {
  // The bug this replaces: occupancy counted occupancy_status === "Occupied",
  // which drops every household under eviction or having given notice. On the
  // live portfolio that was 58 units, and it read 56.9% where the truth is 64.5%.
  state.rows = [
    unit(1),
    unit(2, { occupancy_status: "Notice", occupied: true }),
    unit(3, { occupancy_status: "Vacant", occupied: false }),
  ];
  const { stats } = await listResmanUnits();
  assert.equal(stats.occupied, 2, "the Notice unit is occupied");
  assert.equal(stats.vacant, 1);
  assert.equal(stats.notice, 1, "and is still reported as on notice");
});

test("non-rentable units leave the denominator, not just the numerator", async () => {
  // A unit flagged out of the occupancy count is not vacant stock waiting to be
  // leased; dividing by every row inflated vacancy and deflated occupancy.
  state.rows = [
    unit(1),
    unit(2, { occupancy_status: "Vacant", occupied: false }),
    unit(3, { occupancy_status: "Vacant", occupied: false, excluded_from_occupancy: true }),
    unit(4, { occupancy_status: "Vacant", occupied: false, holding_unit: true }),
  ];
  const { stats } = await listResmanUnits();
  assert.equal(stats.total, 4, "the table still lists every row");
  assert.equal(stats.rentable, 2, "but only two are rentable apartments");
  assert.equal(stats.occupied, 1);
  assert.equal(stats.vacant, 1);
  assert.equal((stats.occupied / stats.rentable) * 100, 50, "50%, not 25%");
});

test("occupied and vacant partition the rentable stock", async () => {
  // What keeps the occupancy-mix bar from overflowing: the two segments are
  // complementary, and notice is drawn inside occupied rather than beside it.
  state.rows = [
    unit(1),
    unit(2, { occupancy_status: "Notice" }),
    unit(3, { occupancy_status: "Vacant", occupied: false }),
    unit(4, { occupancy_status: "Vacant", occupied: false, excluded_from_occupancy: true }),
    unit(5, { occupancy_status: "Occupied", occupied: null }),
  ];
  const { stats } = await listResmanUnits();
  assert.equal(stats.occupied + stats.vacant, stats.rentable, "no unit is both or neither");
  assert.ok(stats.notice <= stats.occupied, "notice is a subset, never a third bucket");
  // A null `occupied` is not a claim that someone lives there.
  assert.equal(stats.occupied, 2);
});

test("an empty mirror reports zeroes rather than dividing by zero", async () => {
  state.rows = [];
  const { stats } = await listResmanUnits();
  assert.equal(stats.total, 0);
  assert.equal(stats.rentable, 0);
  assert.equal(stats.occupied, 0);
  assert.equal(stats.vacant, 0);
});

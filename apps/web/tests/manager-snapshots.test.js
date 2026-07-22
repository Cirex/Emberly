const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");

// Same bun:test mock.module harness as tests/manager-api.test.js — this suite
// runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = {
  /** What requireResmanApiKey answers. */
  auth: { ok: false, response: null },
  /** Scripted untyped Supabase client. */
  db: null,
};

mock.module("@/lib/resman-api-auth", () => ({
  requireResmanApiKey: async () => state.auth,
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const { monthsAgoIsoDate } = require("../lib/manager-leases");
const {
  SNAPSHOT_MONTHS_CAP,
  SNAPSHOT_MONTHS_DEFAULT,
  clampSnapshotMonths,
} = require("../lib/manager-snapshots");

const snapshotsRoute = require("../app/api/resman/manager/snapshots/route.ts");

// --- shared fakes (mirrors tests/manager-api.test.js) ----------------------

function tokenAuth() {
  return {
    ok: true,
    kind: "token",
    subject: {
      tokenId: "token-1",
      kind: "api_resman",
      subjectType: "admin_user",
      subjectId: "admin-7",
      label: "Priya Manager",
      role: "staff",
      scopes: [],
    },
  };
}

function untouchableDb() {
  return {
    from() {
      throw new Error("Supabase must not be touched");
    },
  };
}

function scriptedSupabase(scripts, operations = []) {
  return {
    from(table) {
      const script = scripts.shift();
      if (!script) throw new Error(`Unexpected Supabase table ${table}`);
      assert.equal(table, script.table);
      const start = (action, extra) => {
        const result = script[action];
        if (result === undefined) throw new Error(`No scripted ${action} for ${table}`);
        const operation = { table, action, filters: [], orderBy: [], ...extra };
        operations.push(operation);
        return chain(result, operation);
      };
      return {
        select: (columns) => start("select", { columns }),
      };
    },
  };
}

function chain(result, operation) {
  const q = {
    gte(column, value) {
      operation.filters.push([`gte:${column}`, value]);
      return q;
    },
    order(column, options) {
      operation.orderBy.push([column, options]);
      return q;
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return q;
}

function snapshotsRequest(query = "") {
  return new Request(`https://emberly-web.test/api/resman/manager/snapshots${query}`);
}

// --- pure helper: range clamp ----------------------------------------------

test("clampSnapshotMonths: default 12, clamped to [1, 24], junk falls back", () => {
  assert.equal(SNAPSHOT_MONTHS_DEFAULT, 12);
  assert.equal(SNAPSHOT_MONTHS_CAP, 24);
  assert.equal(clampSnapshotMonths(null), 12);
  assert.equal(clampSnapshotMonths(""), 12);
  assert.equal(clampSnapshotMonths("  "), 12);
  assert.equal(clampSnapshotMonths("6"), 6);
  assert.equal(clampSnapshotMonths("24"), 24);
  assert.equal(clampSnapshotMonths("25"), 24);
  assert.equal(clampSnapshotMonths("999"), 24);
  assert.equal(clampSnapshotMonths("0"), 1);
  assert.equal(clampSnapshotMonths("-3"), 1);
  assert.equal(clampSnapshotMonths("3.9"), 3);
  assert.equal(clampSnapshotMonths("banana"), 12);
});

// --- auth gating ------------------------------------------------------------

test("unauthenticated requests get 401 and never touch the DB", async () => {
  state.db = untouchableDb();
  state.auth = {
    ok: false,
    response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  };
  const response = await snapshotsRoute.GET(snapshotsRequest());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Unauthorized");
});

test("scanner credentials are refused: snapshots are staff-only", async () => {
  state.auth = { ok: true, kind: "scanner" };
  state.db = untouchableDb();
  const response = await snapshotsRoute.GET(snapshotsRequest());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Forbidden");
});

// --- GET /manager/snapshots -------------------------------------------------

function snapshotRow(overrides = {}) {
  return {
    snapshot_date: "2026-07-21",
    total_units: 878,
    occupied_units: 811,
    vacant_units: 67,
    occupancy_pct: 92.37,
    rent_roll: 1090000,
    lease_rent_total: 1004500.5,
    balance_total: 48200.25,
    balance_0_30: 18300,
    balance_31_60: 13000,
    balance_61_90: 10100,
    balance_90_plus: 6800.25,
    delinquent_units: 61,
    turns_in_progress: 12,
    open_work_orders: 148,
    utility_due: 9800.4,
    source: "nightly",
    ...overrides,
  };
}

test("GET snapshots returns the window as camelCase DTOs, oldest first", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "property_snapshots",
        select: {
          data: [
            // A backfilled day: occupancy family only, everything else null.
            snapshotRow({
              snapshot_date: "2025-07-22",
              rent_roll: null,
              lease_rent_total: null,
              balance_total: null,
              balance_0_30: null,
              balance_31_60: null,
              balance_61_90: null,
              balance_90_plus: null,
              delinquent_units: null,
              turns_in_progress: null,
              open_work_orders: null,
              utility_due: null,
              source: "backfill",
            }),
            snapshotRow(),
          ],
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await snapshotsRoute.GET(snapshotsRequest());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.snapshots.length, 2);
  assert.deepEqual(data.snapshots[0], {
    date: "2025-07-22",
    totalUnits: 878,
    occupiedUnits: 811,
    vacantUnits: 67,
    occupancyPct: 92.37,
    rentRoll: null,
    leaseRentTotal: null,
    balanceTotal: null,
    balance0To30: null,
    balance31To60: null,
    balance61To90: null,
    balance90Plus: null,
    delinquentUnits: null,
    turnsInProgress: null,
    openWorkOrders: null,
    utilityDue: null,
    source: "backfill",
  });
  assert.deepEqual(data.snapshots[1], {
    date: "2026-07-21",
    totalUnits: 878,
    occupiedUnits: 811,
    vacantUnits: 67,
    occupancyPct: 92.37,
    rentRoll: 1090000,
    leaseRentTotal: 1004500.5,
    balanceTotal: 48200.25,
    balance0To30: 18300,
    balance31To60: 13000,
    balance61To90: 10100,
    balance90Plus: 6800.25,
    delinquentUnits: 61,
    turnsInProgress: 12,
    openWorkOrders: 148,
    utilityDue: 9800.4,
    source: "nightly",
  });

  // Default window: 12 months back, date-ascending.
  const [op] = operations;
  assert.deepEqual(op.filters, [["gte:snapshot_date", monthsAgoIsoDate(Date.now(), 12)]]);
  assert.deepEqual(op.orderBy, [["snapshot_date", { ascending: true }]]);
});

test("GET snapshots clamps ?months= to the 24-month cap", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "property_snapshots", select: { data: [], error: null } }],
    operations,
  );

  const response = await snapshotsRoute.GET(snapshotsRequest("?months=48"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.snapshots, []);
  assert.deepEqual(operations[0].filters, [
    ["gte:snapshot_date", monthsAgoIsoDate(Date.now(), 24)],
  ]);
});

test("GET snapshots honors an in-range ?months=", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "property_snapshots", select: { data: [], error: null } }],
    operations,
  );

  const response = await snapshotsRoute.GET(snapshotsRequest("?months=3"));
  assert.equal(response.status, 200);
  assert.deepEqual(operations[0].filters, [
    ["gte:snapshot_date", monthsAgoIsoDate(Date.now(), 3)],
  ]);
});

test("GET snapshots answers 500 when the read fails", async () => {
  state.auth = tokenAuth();
  state.db = scriptedSupabase([
    { table: "property_snapshots", select: { data: null, error: { message: "boom" } } },
  ]);

  const response = await snapshotsRoute.GET(snapshotsRequest());
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "Internal server error");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("bun:test");

// Same bun:test mock.module harness as tests/pm-tasks.test.js — this suite runs
// in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = {
  /** What requireResmanApiKey answers. */
  auth: { ok: true, kind: "scanner", subject: { scannerId: "gate-1" } },
  /** Scripted untyped Supabase client. */
  db: null,
};

const realResmanApiAuth = require("../lib/resman-api-auth.ts");

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

mock.module("@/lib/resman-api-auth", () => ({
  ...realResmanApiAuth,
  requireResmanApiKey: async () => state.auth,
}));

const { listAdminAlerts } = require("../lib/admin-alerts.ts");
const detailsRoute = require("../app/api/resman/units/details/route.ts");

// --- Finding A: derived alerts refresh in one round trip ------------------

/**
 * Records every operation and answers from `results`, keyed `table:action`.
 * Resolution is synchronous — this half only counts round trips.
 */
function recordingSupabase(results, operations) {
  return {
    from(table) {
      const operation = { table, action: "select", filters: [] };
      const chain = {
        select(columns) {
          operation.action = "select";
          operation.columns = columns;
          return chain;
        },
        update(patch) {
          operation.action = "update";
          operation.patch = patch;
          return chain;
        },
        insert(values) {
          operation.action = "insert";
          operation.values = values;
          return chain;
        },
        upsert(values, options) {
          operation.action = "upsert";
          operation.values = values;
          operation.options = options;
          return chain;
        },
        eq(column, value) {
          operation.filters.push(["eq", column, value]);
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        then(resolve, reject) {
          operations.push(operation);
          const result = results[`${operation.table}:${operation.action}`] ?? {
            data: [],
            error: null,
          };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

function deniedResident(id) {
  return {
    id,
    name: `Resident ${id}`,
    unit_id: "101",
    access_allowed: false,
    access_status: "not allowed",
    last_resman_verified_at: new Date().toISOString(),
  };
}

function openAlertFor(id, residentId) {
  return {
    id,
    alert_type: "resident_access_denied",
    subject_type: "resident",
    subject_id: residentId,
  };
}

test("derived alerts already open refresh in one batched upsert, not one update each", async () => {
  const operations = [];
  state.db = recordingSupabase(
    {
      "residents:select": {
        data: [deniedResident("r1"), deniedResident("r2"), deniedResident("r3")],
        error: null,
      },
      "scanner_devices:select": { data: [], error: null },
      "admin_alerts:select": {
        data: [openAlertFor("a1", "r1"), openAlertFor("a2", "r2"), openAlertFor("a3", "r3")],
        error: null,
      },
      "admin_alerts:upsert": { data: null, error: null },
    },
    operations,
  );

  await listAdminAlerts();

  const updates = operations.filter((op) => op.table === "admin_alerts" && op.action === "update");
  assert.deepEqual(updates, [], "existing alerts must not be updated one at a time");

  const upserts = operations.filter((op) => op.table === "admin_alerts" && op.action === "upsert");
  assert.equal(upserts.length, 1, "all existing alerts refresh in a single round trip");
  assert.equal(upserts[0].values.length, 3);
  // The primary key, not the partial unique index on open alerts, which
  // PostgREST cannot target.
  assert.equal(upserts[0].options?.onConflict, "id");
  assert.deepEqual(
    upserts[0].values.map((row) => row.id),
    ["a1", "a2", "a3"],
  );
  assert.deepEqual(
    upserts[0].values.map((row) => row.subject_id),
    ["r1", "r2", "r3"],
  );

  assert.equal(
    operations.filter((op) => op.action === "insert").length,
    0,
    "nothing new to insert when every derived alert is already open",
  );
});

test("derived alerts with no open row still take the insert path", async () => {
  const operations = [];
  state.db = recordingSupabase(
    {
      "residents:select": { data: [deniedResident("r1"), deniedResident("r2")], error: null },
      "scanner_devices:select": { data: [], error: null },
      "admin_alerts:select": { data: [openAlertFor("a1", "r1")], error: null },
      "admin_alerts:upsert": { data: null, error: null },
      "admin_alerts:insert": { data: null, error: null },
    },
    operations,
  );

  await listAdminAlerts();

  const inserts = operations.filter((op) => op.action === "insert");
  assert.equal(inserts.length, 1);
  assert.deepEqual(
    inserts[0].values.map((row) => row.subject_id),
    ["r2"],
  );
  assert.equal(
    inserts[0].values.every((row) => row.id === undefined),
    true,
    "new alerts let the database mint the id",
  );
});

// --- Finding B: the bulk detail route reads its tables in parallel --------

/**
 * Answers whole tables after a tick, tracking how many reads are in flight at
 * once — one at a time is the serial-await regression this guards.
 */
function concurrencyTrackingSupabase(tables, stats) {
  return {
    from(table) {
      let range = null;
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        gt() {
          return chain;
        },
        order() {
          return chain;
        },
        range(from, to) {
          range = [from, to];
          return chain;
        },
        then(resolve, reject) {
          stats.inFlight += 1;
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
          return new Promise((done) => setTimeout(done, 5))
            .then(() => {
              stats.inFlight -= 1;
              const rows = tables[table] ?? [];
              const [from, to] = range ?? [0, rows.length - 1];
              return { data: rows.slice(from, to + 1), error: null };
            })
            .then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const DETAIL_TABLES = {
  resman_units: [
    { resman_unit_id: "U1", number: "101", current_lease_id: "L1" },
    { resman_unit_id: "U2", number: "102", current_lease_id: null },
  ],
  residents: [
    { id: "r1", name: "Ada", access_allowed: true, unit_id: "101" },
    { id: "r2", name: "Bo", access_allowed: true, unit_id: "102" },
  ],
  resman_residents: [{ resman_lease_id: "L1", resman_person_lease_id: "P1" }],
  resman_lease_vehicles: [
    {
      resman_person_lease_id: "P1",
      resman_vehicle_id: "V1",
      make: "Honda",
      model: "Civic",
      year: "2019",
      color: "Blue",
      license_plate: "ABC123",
      license_plate_state: "TN",
      parking_spot: "12",
    },
  ],
  guest_pass_unit_bans: [
    {
      resman_unit_id: "U2",
      unit_number: "102",
      reason: "noise",
      banned_by: "admin",
      banned_at: "2026-08-01T00:00:00.000Z",
      expiry_kind: "never",
      expires_at: null,
      bound_lease_id: null,
      status_trigger: null,
    },
  ],
  guest_pass_bans: [{ resident_id: "r1" }],
  guest_passes: [
    {
      id: "g1",
      resident_id: "r1",
      guest_name: "Cy",
      expires_at: "2030-01-01T00:00:00.000Z",
      created_at: "2026-08-30T00:00:00.000Z",
    },
  ],
  entry_logs: [
    {
      id: "e2",
      entry_type: "guest",
      tenant_name: "Ada",
      entered_at: "2026-08-30T10:00:00.000Z",
      unit_address: "101",
    },
    {
      id: "e1",
      entry_type: "resident",
      tenant_name: "Ada",
      entered_at: "2026-08-29T10:00:00.000Z",
      unit_address: "101",
    },
  ],
};

test("unit details reads its independent tables in parallel", async () => {
  const stats = { inFlight: 0, maxInFlight: 0 };
  state.db = concurrencyTrackingSupabase(DETAIL_TABLES, stats);

  const response = await detailsRoute.GET(
    new Request("https://emberly.test/api/resman/units/details"),
  );
  assert.equal(response.status, 200);

  assert.ok(
    stats.maxInFlight >= 8,
    `expected the eight independent reads to overlap, saw at most ${stats.maxInFlight} in flight`,
  );
});

test("unit details reduces the same shape whether or not the reads overlap", async () => {
  const stats = { inFlight: 0, maxInFlight: 0 };
  state.db = concurrencyTrackingSupabase(DETAIL_TABLES, stats);

  const response = await detailsRoute.GET(
    new Request("https://emberly.test/api/resman/units/details"),
  );
  const { data } = await response.json();

  assert.deepEqual(data.U1, {
    vehicles: [
      {
        id: "V1",
        make: "Honda",
        model: "Civic",
        year: "2019",
        color: "Blue",
        licensePlate: "ABC123",
        licensePlateState: "TN",
        parkingSpot: "12",
      },
    ],
    lastEntry: {
      id: "e2",
      entryType: "guest",
      tenantName: "Ada",
      enteredAt: "2026-08-30T10:00:00.000Z",
    },
    guestPasses: [
      {
        id: "g1",
        guestName: "Cy",
        hostName: "Ada",
        expiresAt: "2030-01-01T00:00:00.000Z",
        createdAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    guestAccess: { residents: 1, allowed: 0, banned: 1, unitBanned: false },
  });

  assert.deepEqual(data.U2, {
    vehicles: [],
    lastEntry: null,
    guestPasses: [],
    guestAccess: { residents: 1, allowed: 0, banned: 0, unitBanned: true },
  });
});

// --- Finding C: unit_address is an exposed filter, so it gets an index ----

test("entry_logs indexes the unit_address filter, in schema.sql and a delta", () => {
  const schema = fs.readFileSync(path.join(process.cwd(), "lib/supabase/schema.sql"), "utf8");
  assert.match(
    schema,
    /create index entry_logs_unit_address_entered_at_idx on entry_logs \(unit_address, entered_at desc\);/,
  );

  const deltasDir = path.join(process.cwd(), "lib/supabase/deltas");
  const delta = fs
    .readdirSync(deltasDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}-.*\.sql$/.test(name))
    .map((name) => fs.readFileSync(path.join(deltasDir, name), "utf8"))
    .find((sql) => sql.includes("entry_logs_unit_address_entered_at_idx"));

  assert.ok(delta, "no delta creates entry_logs_unit_address_entered_at_idx");
  assert.match(delta, /\(unit_address, entered_at desc\)/);
});

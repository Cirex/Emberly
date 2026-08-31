const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

// Same bun:test mock.module harness as tests/admin-units-occupancy.test.js —
// this suite runs in its own process (the package.json `test` script runs each
// file separately), so the process-global mocks cannot leak into other files.

/**
 * PostgREST returns at most this many rows per response regardless of what
 * `.limit()` asked for (the server-side `db-max-rows` ceiling). The stub
 * enforces it, so any read that trusts a single response is visibly short here.
 */
const PAGE_CEILING = 1000;

const state = { tables: {} };

function matches(row, filters) {
  return filters.every(([op, column, value, extra]) => {
    if (op === "eq") return row[column] === value;
    if (op === "gte") return row[column] >= value;
    if (op === "not") return value === "is" && extra === null && row[column] != null;
    return true;
  });
}

function sortRows(rows, order) {
  if (order.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const [column, ascending] of order) {
      if (a[column] === b[column]) continue;
      const cmp = a[column] < b[column] ? -1 : 1;
      return ascending ? cmp : -cmp;
    }
    return 0;
  });
}

function stubClient() {
  return {
    from(table) {
      const query = { order: [], filters: [], head: false, limit: null, range: null };

      function resolve() {
        const rows = sortRows(
          (state.tables[table] ?? []).filter((row) => matches(row, query.filters)),
          query.order,
        );
        if (query.head) return { data: null, error: null, count: rows.length };
        if (query.range) {
          const [from, to] = query.range;
          return { data: rows.slice(from, Math.min(to + 1, from + PAGE_CEILING)), error: null };
        }
        return {
          data: rows.slice(0, Math.min(query.limit ?? PAGE_CEILING, PAGE_CEILING)),
          error: null,
        };
      }

      const builder = {
        select(columns, options) {
          query.head = Boolean(options?.head);
          return builder;
        },
        eq(column, value) {
          query.filters.push(["eq", column, value]);
          return builder;
        },
        gte(column, value) {
          query.filters.push(["gte", column, value]);
          return builder;
        },
        not(column, operator, value) {
          query.filters.push(["not", column, operator, value]);
          return builder;
        },
        order(column, options) {
          query.order.push([column, options?.ascending !== false]);
          return builder;
        },
        limit(count) {
          query.limit = count;
          return builder;
        },
        range(from, to) {
          query.range = [from, to];
          return builder;
        },
        maybeSingle() {
          const { data, error } = resolve();
          return Promise.resolve({ data: data?.[0] ?? null, error });
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve(resolve()).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: stubClient,
  createUntypedAdminClient: stubClient,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const { getAdminStats } = require("../lib/admin-stats");
const { getScannerActivity, getScannerScanCountsToday } = require("../lib/admin-scanner-activity");
const { startOfPropertyDay, propertyDayKey } = require("../lib/property-time");

/** `count` timestamps spread between the property day's start and `now`. */
function timestampsToday(now, count) {
  const start = startOfPropertyDay(now).getTime();
  const span = Math.max(now.getTime() - start, 0);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + Math.floor((span * i) / Math.max(count, 1))).toISOString(),
  );
}

function entryLogs(now, count, over = () => ({})) {
  return timestampsToday(now, count).map((entered_at, i) => ({
    id: `log-${String(i).padStart(5, "0")}`,
    entry_type: i % 3 === 0 ? "guest" : "resident",
    tenant_name: `Tenant ${i}`,
    unit_address: `Unit ${i % 4}`,
    property_name: "Emberly",
    resident_id: `resident-${i}`,
    entered_at,
    scanner_id: "gate-1",
    ...over(i),
  }));
}

test("admin stats count every entry in the window, not the first page of it", async () => {
  // A `.limit()` above the page ceiling does not raise it: the histogram, the
  // per-day buckets and the top-unit tally were all computed on the first 1000
  // rows, so a busy week reported numbers that were simply wrong.
  const now = new Date();
  state.tables = {
    entry_logs: entryLogs(now, 1500),
    residents: [],
    guest_passes: [],
  };

  const stats = await getAdminStats(now);
  const todayKey = propertyDayKey(now);
  const today = stats.byDay.find((day) => day.date === todayKey);

  assert.equal(today.total, 1500, "every entry today lands in the day bucket");
  assert.equal(
    stats.byHour.reduce((sum, count) => sum + count, 0),
    1500,
    "and in the hour histogram",
  );
  assert.equal(
    stats.topUnits.reduce((sum, unit) => sum + unit.count, 0),
    1500,
    "and in the top-unit tally",
  );
});

test("resident access health is summarized over every resident", async () => {
  const now = new Date();
  state.tables = {
    entry_logs: [],
    guest_passes: [],
    residents: Array.from({ length: 1200 }, (_, i) => ({
      id: `resident-${String(i).padStart(5, "0")}`,
      access_allowed: true,
      access_status: "Current",
      last_resman_verified_at: now.toISOString(),
    })),
  };

  const stats = await getAdminStats(now);

  assert.equal(stats.residents.total, 1200);
  assert.equal(stats.residents.access.verified, 1200, "no resident is dropped by the page ceiling");
});

test("guest pass usage is counted in Postgres, not by measuring a truncated array", async () => {
  const now = new Date();
  state.tables = {
    entry_logs: [],
    residents: [],
    guest_passes: Array.from({ length: 1200 }, (_, i) => ({
      id: `pass-${String(i).padStart(5, "0")}`,
      created_at: now.toISOString(),
      used_at: i % 2 === 0 ? now.toISOString() : null,
    })),
  };

  const stats = await getAdminStats(now);

  assert.equal(stats.guestPasses.created, 1200);
  assert.equal(stats.guestPasses.used, 600);
  assert.equal(stats.guestPasses.usageRate, 50);
});

test("today's per-scanner counts are exact above the page ceiling", async () => {
  // The old read pulled today's scan rows and tallied them in JS, so every
  // scanner's badge stopped climbing once the property passed 1000 scans.
  const now = new Date();
  state.tables = {
    scanner_devices: [
      {
        id: "d1",
        scanner_id: "gate-1",
        name: "Gate 1",
        location: null,
        enabled: true,
        secret_rotated_at: null,
        last_seen_at: now.toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      {
        id: "d2",
        scanner_id: "gate-2",
        name: "Gate 2",
        location: null,
        enabled: true,
        secret_rotated_at: null,
        last_seen_at: now.toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ],
    entry_logs: entryLogs(now, 1500, (i) => ({ scanner_id: i < 1200 ? "gate-1" : "gate-2" })),
  };

  const counts = await getScannerScanCountsToday();

  assert.equal(counts["gate-1"], 1200);
  assert.equal(counts["gate-2"], 300);
});

test("scanner activity totals cover the whole window", async () => {
  const now = new Date();
  state.tables = {
    scanner_devices: [
      {
        id: "d1",
        scanner_id: "gate-1",
        name: "Gate 1",
        location: null,
        enabled: true,
        secret_rotated_at: null,
        last_seen_at: now.toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ],
    entry_logs: entryLogs(now, 1500),
  };

  const activity = await getScannerActivity("gate-1");

  assert.equal(activity.windowTotal, 1500, "no scan is lost to the page ceiling");
  assert.equal(activity.todayTotal, 1500);
  assert.equal(activity.residentTotal + activity.guestTotal, 1500);
  assert.equal(activity.recent.length, 12, "the recent list is still the newest twelve");
});

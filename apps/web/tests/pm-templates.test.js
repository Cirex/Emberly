const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");

// Same bun:test mock.module harness as tests/work-order-photos.test.js — this
// suite runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files. The
// mocks are installed before the lib/routes are required so every consumer
// resolves them.
const state = {
  /** The admin requireAdmin resolves, or null for unauthenticated. */
  admin: null,
  /** Scripted untyped Supabase client. */
  db: null,
};

// Mirrors the real requireAdmin contract: 401 without a session, 403 when a
// role requirement is not met (super_admin always passes) — so these tests
// verify the routes actually PASS roles: ["super_admin"] on writes.
mock.module("@/lib/admin-request", () => ({
  requireAdmin: async (_request, options = {}) => {
    if (!state.admin) {
      return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (options.roles && state.admin.role !== "super_admin" && !options.roles.includes(state.admin.role)) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { ok: true, admin: state.admin };
  },
  getAdminFromSessionCookie: async () => state.admin,
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const {
  buildPmOverview,
  currentRoundKey,
  groupTasksByRound,
  isCompletedOnTime,
  normalizeScopeValues,
  onTimePercent,
  scopeSummary,
} = require("../lib/pm-templates");
const listRoute = require("../app/api/admin/pm-templates/route.ts");
const idRoute = require("../app/api/admin/pm-templates/[id]/route.ts");

// --- shared fakes ---------------------------------------------------------

const SUPER_ADMIN = { adminId: "admin-1", role: "super_admin", displayName: "Sam Super" };
const VIEWER = { adminId: "admin-2", role: "viewer", displayName: "Vic Viewer" };

function untouchableDb() {
  return {
    from() {
      throw new Error("Supabase must not be touched");
    },
  };
}

function scriptedSupabase(scripts, operations) {
  return {
    from(table) {
      const script = scripts.shift();
      if (!script) throw new Error(`Unexpected Supabase table ${table}`);
      assert.equal(table, script.table);
      return {
        select(columns) {
          const operation = { table, action: "select", columns, filters: [] };
          operations.push(operation);
          return chainResult(script.select, operation);
        },
        insert(row) {
          const operation = { table, action: "insert", row, filters: [] };
          operations.push(operation);
          return chainResult(script.insert, operation);
        },
        update(patch) {
          const operation = { table, action: "update", patch, filters: [] };
          operations.push(operation);
          return chainResult(script.update, operation);
        },
        delete() {
          const operation = { table, action: "delete", filters: [] };
          operations.push(operation);
          return chainResult(script.delete, operation);
        },
      };
    },
  };
}

function chainResult(result, operation = null) {
  const query = {
    filters: [],
    selectColumns: [],
    eq(column, value) {
      this.filters.push([column, value]);
      if (operation) operation.filters = this.filters;
      return this;
    },
    order(column, options) {
      this.orderBy = [column, options];
      if (operation) operation.orderBy = this.orderBy;
      return Promise.resolve(result);
    },
    select(columns) {
      this.selectColumns.push(columns);
      if (operation) operation.selectColumns = this.selectColumns;
      return this;
    },
    maybeSingle: async () => result,
    single: async () => result,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return query;
}

function templateRow(overrides = {}) {
  return {
    id: "tpl-1",
    name: "HVAC filter change",
    category: "HVAC",
    cadence: "quarterly",
    anchor_month: null,
    scope_type: "all",
    scope_values: [],
    active: true,
    created_by: "Sam Super",
    created_at: "2026-01-05T12:00:00.000Z",
    updated_at: "2026-01-05T12:00:00.000Z",
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    template_id: "tpl-1",
    round_key: "2026-04",
    status: "pending",
    due_date: "2026-04-15",
    completed_at: null,
    ...overrides,
  };
}

function jsonRequest(method, body) {
  return new Request("https://emberly-web.test/api/admin/pm-templates", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const idParams = { params: Promise.resolve({ id: "tpl-1" }) };

// A local-noon timestamp inside July 2026, safe across timezones.
const JULY_2026 = new Date(2026, 6, 10, 12).getTime();

// --- pure helpers: round keys ---------------------------------------------

test("currentRoundKey matches the generator's anchor-cycle math", () => {
  // Monthly ignores the anchor: the round is simply the current month.
  assert.equal(currentRoundKey("monthly", null, JULY_2026), "2026-07");
  assert.equal(currentRoundKey("monthly", 10, JULY_2026), "2026-07");
  // Quarterly anchored to April: May falls in the period starting April.
  assert.equal(currentRoundKey("quarterly", 4, new Date(2026, 4, 15, 12).getTime()), "2026-04");
  // Semiannual anchored to October wraps the year: February → previous October.
  assert.equal(currentRoundKey("semiannual", 10, new Date(2026, 1, 15, 12).getTime()), "2025-10");
  // Annual anchored to October: July 2026 is inside the round started Oct 2025.
  assert.equal(currentRoundKey("annual", 10, JULY_2026), "2025-10");
  // Null anchor defaults to January.
  assert.equal(currentRoundKey("annual", null, JULY_2026), "2026-01");
});

// --- pure helpers: on-time math -------------------------------------------

test("isCompletedOnTime counts any completion up to the end of the due day", () => {
  // Late-evening completion ON the due date is on time (date-only due dates).
  assert.equal(isCompletedOnTime(new Date(2026, 3, 15, 23, 30).toISOString(), "2026-04-15"), true);
  assert.equal(isCompletedOnTime(new Date(2026, 3, 10, 9).toISOString(), "2026-04-15"), true);
  // The morning after is late.
  assert.equal(isCompletedOnTime(new Date(2026, 3, 16, 0, 30).toISOString(), "2026-04-15"), false);
  assert.equal(isCompletedOnTime(null, "2026-04-15"), false);
  assert.equal(isCompletedOnTime("not-a-date", "2026-04-15"), false);
});

test("onTimePercent is null with no done tasks and rounds to a whole percent", () => {
  assert.equal(onTimePercent([]), null);
  assert.equal(onTimePercent([task(), task({ status: "skipped" })]), null);

  const onTime = task({ status: "done", completed_at: new Date(2026, 3, 14, 12).toISOString() });
  const late = task({ status: "done", completed_at: new Date(2026, 3, 20, 12).toISOString() });
  assert.equal(onTimePercent([onTime, late, task()]), 50);
  assert.equal(onTimePercent([onTime, onTime, late]), 67);
});

// --- pure helpers: grouping + scope ---------------------------------------

test("groupTasksByRound aggregates counts per round, newest first", () => {
  const rounds = groupTasksByRound([
    task({ round_key: "2026-01", due_date: "2026-01-15", status: "done", completed_at: "2026-01-10T12:00:00Z" }),
    task({ round_key: "2026-01", due_date: "2026-01-15", status: "skipped" }),
    task({ round_key: "2026-04", unit_number: "101" }),
    task({ round_key: "2026-04", status: "done", completed_at: "2026-04-10T12:00:00Z" }),
    task({ round_key: "2026-04", status: "pending" }),
  ]);
  assert.deepEqual(rounds, [
    { roundKey: "2026-04", dueDate: "2026-04-15", total: 3, done: 1, skipped: 0, pending: 2 },
    { roundKey: "2026-01", dueDate: "2026-01-15", total: 2, done: 1, skipped: 1, pending: 0 },
  ]);
});

test("scopeSummary and normalizeScopeValues render and clean scope inputs", () => {
  assert.equal(scopeSummary("all", ["ignored"]), "All units");
  assert.equal(scopeSummary("building", ["3", "4"]), "Buildings: 3, 4");
  assert.equal(scopeSummary("classification", ["2BR"]), "Classification: 2BR");
  assert.equal(scopeSummary("building", []), "Buildings: none set");
  assert.deepEqual(normalizeScopeValues([" 3 ", "", "4", "3", "  "]), ["3", "4"]);
});

// --- pure helpers: overview aggregation -----------------------------------

test("buildPmOverview rolls up current-round progress and on-time stats", () => {
  const templates = [
    templateRow({ id: "tpl-1", cadence: "monthly", anchor_month: null }),
    templateRow({ id: "tpl-2", name: "Gutter cleaning", cadence: "annual", anchor_month: 10, active: false }),
  ];
  const tasks = [
    // tpl-1 current round (July 2026): 1 done on time, 1 pending, 1 skipped.
    task({ template_id: "tpl-1", round_key: "2026-07", due_date: "2026-07-15", status: "done", completed_at: new Date(2026, 6, 12, 9).toISOString() }),
    task({ template_id: "tpl-1", round_key: "2026-07", due_date: "2026-07-15" }),
    task({ template_id: "tpl-1", round_key: "2026-07", due_date: "2026-07-15", status: "skipped" }),
    // tpl-1 prior round: 1 done late.
    task({ template_id: "tpl-1", round_key: "2026-06", due_date: "2026-06-15", status: "done", completed_at: new Date(2026, 5, 20, 9).toISOString() }),
    // tpl-2 (inactive) current round has a pending task — excluded from summary.
    task({ template_id: "tpl-2", round_key: "2025-10", due_date: "2025-10-15" }),
  ];

  const overview = buildPmOverview(templates, tasks, JULY_2026);

  const [t1, t2] = overview.templates;
  assert.equal(t1.stats.currentRoundKey, "2026-07");
  assert.equal(t1.stats.currentDone, 1);
  assert.equal(t1.stats.currentTotal, 3);
  assert.equal(t1.stats.currentSkipped, 1);
  assert.equal(t1.stats.currentPending, 1);
  assert.equal(t1.stats.onTimePercent, 50); // 1 on time of 2 done
  assert.deepEqual(t1.stats.rounds.map((r) => r.roundKey), ["2026-07", "2026-06"]);

  assert.equal(t2.stats.currentRoundKey, "2025-10");
  assert.equal(t2.stats.currentTotal, 1);

  assert.deepEqual(overview.summary, {
    activeTemplates: 1,
    dueThisRound: 1, // tpl-2 is inactive, so its pending task doesn't count
    currentRoundDone: 1,
    currentRoundTotal: 3,
    currentRoundPercent: 33,
    overallOnTimePercent: 50,
  });
});

// --- auth gating ----------------------------------------------------------

test("unauthenticated requests get 401 on every route and never touch the DB", async () => {
  state.admin = null;
  state.db = untouchableDb();

  const attempts = [
    listRoute.GET(new Request("https://emberly-web.test/api/admin/pm-templates")),
    listRoute.POST(jsonRequest("POST", { name: "X", cadence: "monthly" })),
    idRoute.PATCH(jsonRequest("PATCH", { active: false }), idParams),
    idRoute.DELETE(new Request("https://emberly-web.test/api/admin/pm-templates/tpl-1", { method: "DELETE" }), idParams),
  ];
  for (const attempt of attempts) {
    const response = await attempt;
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Unauthorized");
  }
});

test("non-super_admin admins can read but every write answers 403 with the DB untouched", async () => {
  state.admin = VIEWER;
  state.db = scriptedSupabase(
    [
      { table: "pm_templates", select: { data: [], error: null } },
      { table: "pm_tasks", select: { data: [], error: null } },
    ],
    [],
  );

  const read = await listRoute.GET(new Request("https://emberly-web.test/api/admin/pm-templates"));
  assert.equal(read.status, 200);

  state.db = untouchableDb();
  const writes = [
    listRoute.POST(jsonRequest("POST", { name: "X", cadence: "monthly" })),
    idRoute.PATCH(jsonRequest("PATCH", { active: false }), idParams),
    idRoute.DELETE(new Request("https://emberly-web.test/api/admin/pm-templates/tpl-1", { method: "DELETE" }), idParams),
  ];
  for (const attempt of writes) {
    const response = await attempt;
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Forbidden");
  }
});

// --- validation -----------------------------------------------------------

test("create rejects an empty name, a bad cadence, and an out-of-range anchor month", async () => {
  state.admin = SUPER_ADMIN;
  state.db = untouchableDb();

  const bad = [
    { cadence: "monthly" }, // name missing
    { name: "   ", cadence: "monthly" }, // name empty after trim
    { name: "X", cadence: "weekly" }, // cadence not in the enum
    { name: "X", cadence: "annual", anchorMonth: 0 },
    { name: "X", cadence: "annual", anchorMonth: 13 },
    { name: "X", cadence: "annual", anchorMonth: 2.5 },
    { name: "X", cadence: "monthly", scopeType: "floor" },
    { name: "X", cadence: "monthly", scopeValues: "3,4" }, // must be an array
  ];
  for (const body of bad) {
    const response = await listRoute.POST(jsonRequest("POST", body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "Invalid request");
  }

  const noBody = await listRoute.POST(
    new Request("https://emberly-web.test/api/admin/pm-templates", { method: "POST" }),
  );
  assert.equal(noBody.status, 400);
});

test("patch validation mirrors create and refuses an empty patch", async () => {
  state.admin = SUPER_ADMIN;
  state.db = untouchableDb();

  for (const body of [{ anchorMonth: 13 }, { cadence: "weekly" }, { name: "" }]) {
    const response = await idRoute.PATCH(jsonRequest("PATCH", body), idParams);
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  const empty = await idRoute.PATCH(jsonRequest("PATCH", {}), idParams);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "No fields to update");
});

// --- create ---------------------------------------------------------------

test("create inserts a normalized row with defaults and attribution", async () => {
  const operations = [];
  const inserted = templateRow({ scope_type: "building", scope_values: ["3", "4"] });
  state.admin = SUPER_ADMIN;
  state.db = scriptedSupabase([{ table: "pm_templates", insert: { data: inserted, error: null } }], operations);

  const response = await listRoute.POST(
    jsonRequest("POST", {
      name: "  HVAC filter change  ",
      category: " HVAC ",
      cadence: "quarterly",
      scopeType: "building",
      scopeValues: [" 3 ", "4", "", "3"],
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { data: inserted });

  const insert = operations.find((operation) => operation.action === "insert");
  assert.ok(insert);
  assert.deepEqual(insert.row, {
    name: "HVAC filter change",
    category: "HVAC",
    cadence: "quarterly",
    anchor_month: null,
    scope_type: "building",
    scope_values: ["3", "4"],
    active: true,
    created_by: "Sam Super",
  });
});

// --- patch ----------------------------------------------------------------

test("patch toggles active and maps camelCase fields to columns", async () => {
  const operations = [];
  const updated = templateRow({ active: false, anchor_month: 10 });
  state.admin = SUPER_ADMIN;
  state.db = scriptedSupabase([{ table: "pm_templates", update: { data: updated, error: null } }], operations);

  const response = await idRoute.PATCH(
    jsonRequest("PATCH", { active: false, anchorMonth: 10, scopeValues: [" 2BR ", ""] }),
    idParams,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: updated });

  const update = operations.find((operation) => operation.action === "update");
  assert.ok(update);
  assert.deepEqual(update.patch, { active: false, anchor_month: 10, scope_values: ["2BR"] });
  assert.deepEqual(update.filters, [["id", "tpl-1"]]);
});

test("patch answers 404 when the template is gone", async () => {
  state.admin = SUPER_ADMIN;
  state.db = scriptedSupabase([{ table: "pm_templates", update: { data: null, error: null } }], []);

  const response = await idRoute.PATCH(jsonRequest("PATCH", { active: true }), idParams);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "PM template not found");
});

// --- delete ---------------------------------------------------------------

test("delete removes an existing template (tasks cascade in the DB)", async () => {
  const operations = [];
  state.admin = SUPER_ADMIN;
  state.db = scriptedSupabase(
    [
      { table: "pm_templates", select: { data: { id: "tpl-1" }, error: null } },
      { table: "pm_templates", delete: { data: null, error: null } },
    ],
    operations,
  );

  const response = await idRoute.DELETE(
    new Request("https://emberly-web.test/api/admin/pm-templates/tpl-1", { method: "DELETE" }),
    idParams,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { id: "tpl-1" } });

  const del = operations.find((operation) => operation.action === "delete");
  assert.ok(del);
  assert.deepEqual(del.filters, [["id", "tpl-1"]]);
});

test("delete answers 404 for an unknown template without issuing a delete", async () => {
  const operations = [];
  state.admin = SUPER_ADMIN;
  state.db = scriptedSupabase([{ table: "pm_templates", select: { data: null, error: null } }], operations);

  const response = await idRoute.DELETE(
    new Request("https://emberly-web.test/api/admin/pm-templates/tpl-1", { method: "DELETE" }),
    idParams,
  );
  assert.equal(response.status, 404);
  assert.equal(operations.filter((operation) => operation.action === "delete").length, 0);
});

// --- GET overview through the route ---------------------------------------

test("GET returns templates with stats and the header summary", async () => {
  // Fixtures pinned to the REAL current round so the route's Date.now() agrees.
  const nowRound = currentRoundKey("monthly", null, Date.now());
  state.admin = VIEWER;
  state.db = scriptedSupabase(
    [
      { table: "pm_templates", select: { data: [templateRow({ cadence: "monthly" })], error: null } },
      {
        table: "pm_tasks",
        select: {
          data: [
            task({ round_key: nowRound, due_date: `${nowRound}-15`, status: "done", completed_at: `${nowRound}-10T12:00:00` }),
            task({ round_key: nowRound, due_date: `${nowRound}-15` }),
          ],
          error: null,
        },
      },
    ],
    [],
  );

  const response = await listRoute.GET(new Request("https://emberly-web.test/api/admin/pm-templates"));
  assert.equal(response.status, 200);
  const { data } = await response.json();

  assert.equal(data.templates.length, 1);
  const stats = data.templates[0].stats;
  assert.equal(stats.currentRoundKey, nowRound);
  assert.equal(stats.currentDone, 1);
  assert.equal(stats.currentTotal, 2);
  assert.equal(stats.onTimePercent, 100);
  assert.equal(stats.rounds.length, 1);

  assert.deepEqual(data.summary, {
    activeTemplates: 1,
    dueThisRound: 1,
    currentRoundDone: 1,
    currentRoundTotal: 2,
    currentRoundPercent: 50,
    overallOnTimePercent: 100,
  });
});

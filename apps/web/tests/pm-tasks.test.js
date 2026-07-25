const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");
const { tokenForbiddenForResource } = require("../lib/app-role-capabilities");

// Same bun:test mock.module harness as tests/pm-templates.test.js — this
// suite runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files. The
// mocks are installed before the lib/routes are required so every consumer
// resolves them.
const state = {
  /** What requireResmanApiKey answers. */
  auth: { ok: false, response: null },
  /** Scripted untyped Supabase client. */
  db: null,
};

mock.module("@/lib/resman-api-auth", () => ({
  requireResmanApiKey: async () => state.auth,
  // Only AUTHENTICATION is stubbed. The allow/deny decision runs the real
  // policy from lib/app-role-capabilities.ts, so a route wired to the wrong
  // capability fails here rather than quietly passing a stubbed check.
  requireStaffToken: async (_request, capability) => {
    if (!state.auth.ok) return state.auth;
    if (state.auth.kind === "scanner" || tokenForbiddenForResource(state.auth.subject, capability)) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return state.auth;
  },
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const { buildPmTaskGroups, pmTaskStatusPatch } = require("../lib/pm-tasks");
const { currentRoundKey } = require("../lib/pm-templates");
const listRoute = require("../app/api/resman/pm-tasks/route.ts");
const idRoute = require("../app/api/resman/pm-tasks/[id]/route.ts");

// --- shared fakes ---------------------------------------------------------

function tokenAuth(overrides = {}) {
  return {
    ok: true,
    kind: "token",
    subject: {
      tokenId: "token-1",
      kind: "api_resman",
      subjectType: "admin_user",
      subjectId: "admin-7",
      label: "Marcus Tech",
      role: "security_manager",
      scopes: [],
      ...overrides,
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
        update(patch) {
          const operation = { table, action: "update", patch, filters: [] };
          operations.push(operation);
          return chainResult(script.update, operation);
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
    in(column, values) {
      this.filters.push([`in:${column}`, values]);
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

function taskRow(overrides = {}) {
  return {
    id: "task-1",
    template_id: "tpl-1",
    round_key: "2026-07",
    unit_number: "1809 BA-1",
    due_date: "2026-07-15",
    status: "pending",
    completed_by: "",
    completed_at: null,
    ...overrides,
  };
}

function listRequest(query = "") {
  return new Request(`https://emberly-web.test/api/resman/pm-tasks${query}`);
}

function updateRequest(body) {
  return new Request("https://emberly-web.test/api/resman/pm-tasks/task-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const idParams = { params: Promise.resolve({ id: "task-1" }) };

// A local-noon timestamp inside July 2026, safe across timezones.
const JULY_2026 = new Date(2026, 6, 10, 12).getTime();

// --- pure helpers: grouping -----------------------------------------------

test("buildPmTaskGroups keys each ACTIVE template to its own current round", () => {
  const templates = [
    templateRow({ id: "tpl-1", cadence: "monthly" }),
    // Annual anchored to October: July 2026 sits inside the 2025-10 round.
    templateRow({ id: "tpl-2", name: "Gutter cleaning", cadence: "annual", anchor_month: 10 }),
    templateRow({ id: "tpl-3", name: "Retired", active: false }),
  ];
  const tasks = [
    taskRow({ id: "t-b", template_id: "tpl-1", unit_number: "102" }),
    taskRow({ id: "t-a", template_id: "tpl-1", unit_number: "101", status: "done", completed_by: "QH", completed_at: "2026-07-06T12:00:00.000Z" }),
    // Stale round for tpl-1 — must not leak into the current group.
    taskRow({ id: "t-old", template_id: "tpl-1", round_key: "2026-06", due_date: "2026-06-15" }),
    taskRow({ id: "t-c", template_id: "tpl-2", round_key: "2025-10", due_date: "2025-10-20" }),
  ];

  const groups = buildPmTaskGroups(templates, tasks, null, JULY_2026);

  assert.equal(groups.length, 2); // inactive template dropped
  const [g1, g2] = groups;
  assert.equal(g1.id, "tpl-1");
  assert.equal(g1.roundKey, "2026-07");
  assert.equal(g1.dueDate, "2026-07-15");
  assert.deepEqual(g1.tasks.map((t) => t.id), ["t-b", "t-a"]); // caller's order kept
  assert.deepEqual(g1.tasks[1], {
    id: "t-a",
    unitNumber: "101",
    status: "done",
    completedBy: "QH",
    completedAt: "2026-07-06T12:00:00.000Z",
  });
  assert.equal(g2.roundKey, "2025-10");
  assert.equal(g2.dueDate, "2025-10-20");
});

test("buildPmTaskGroups honors an explicit round and keeps taskless templates", () => {
  const templates = [templateRow({ id: "tpl-1" }), templateRow({ id: "tpl-2", name: "Dryer vents" })];
  const tasks = [
    taskRow({ template_id: "tpl-1", round_key: "2026-04", due_date: "2026-04-15" }),
    taskRow({ id: "task-2", template_id: "tpl-1", round_key: "2026-07" }),
  ];

  const groups = buildPmTaskGroups(templates, tasks, "2026-04", JULY_2026);
  assert.equal(groups[0].roundKey, "2026-04");
  assert.deepEqual(groups[0].tasks.map((t) => t.id), ["task-1"]);
  // A template with nothing generated for the round still appears (empty).
  assert.deepEqual(groups[1], {
    id: "tpl-2",
    name: "Dryer vents",
    category: "HVAC",
    cadence: "quarterly",
    roundKey: "2026-04",
    dueDate: null,
    tasks: [],
  });
});

// --- pure helpers: completion stamping ------------------------------------

test("pmTaskStatusPatch stamps done/skipped and clears pending", () => {
  const now = Date.parse("2026-07-10T15:00:00.000Z");
  assert.deepEqual(pmTaskStatusPatch("done", "app:maintenance · Marcus", "Quinn H", now), {
    status: "done",
    completed_by: "Quinn H",
    completed_at: "2026-07-10T15:00:00.000Z",
  });
  // Blank explicit name falls back to the token label.
  assert.deepEqual(pmTaskStatusPatch("skipped", "Marcus Tech", "   ", now), {
    status: "skipped",
    completed_by: "Marcus Tech",
    completed_at: "2026-07-10T15:00:00.000Z",
  });
  assert.deepEqual(pmTaskStatusPatch("skipped", "Marcus Tech", undefined, now), {
    status: "skipped",
    completed_by: "Marcus Tech",
    completed_at: "2026-07-10T15:00:00.000Z",
  });
  assert.deepEqual(pmTaskStatusPatch("pending", "Marcus Tech", "Quinn H", now), {
    status: "pending",
    completed_by: "",
    completed_at: null,
  });
});

// --- auth gating ----------------------------------------------------------

test("unauthenticated requests get 401 on both routes and never touch the DB", async () => {
  state.db = untouchableDb();

  for (const attempt of [
    () => listRoute.GET(listRequest()),
    () => idRoute.POST(updateRequest({ status: "done" }), idParams),
  ]) {
    // A fresh response per attempt — a NextResponse body reads once.
    state.auth = { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    const response = await attempt();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Unauthorized");
  }
});

test("scanner credentials are refused: PM rounds are a staff surface", async () => {
  state.auth = { ok: true, kind: "scanner" };
  state.db = untouchableDb();

  for (const attempt of [
    listRoute.GET(listRequest()),
    idRoute.POST(updateRequest({ status: "done" }), idParams),
  ]) {
    const response = await attempt;
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Forbidden");
  }
});

// --- GET ------------------------------------------------------------------

test("GET rejects a malformed round without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  for (const round of ["2026", "2026-13", "2026-00", "july", "2026-7"]) {
    const response = await listRoute.GET(listRequest(`?round=${round}`));
    assert.equal(response.status, 400, round);
    assert.equal((await response.json()).error, "Invalid round");
  }
});

test("GET returns active templates' current-round tasks grouped by template", async () => {
  // Fixtures pinned to the REAL current round so the route's Date.now() agrees.
  const nowRound = currentRoundKey("monthly", null, Date.now());
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      { table: "pm_templates", select: { data: [templateRow({ cadence: "monthly" })], error: null } },
      {
        table: "pm_tasks",
        select: {
          data: [
            taskRow({ round_key: nowRound, due_date: `${nowRound}-15` }),
            taskRow({
              id: "task-2",
              round_key: nowRound,
              due_date: `${nowRound}-15`,
              unit_number: "1809 BA-2",
              status: "done",
              completed_by: "Quinn H",
              completed_at: `${nowRound}-06T12:00:00.000Z`,
            }),
          ],
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await listRoute.GET(listRequest());
  assert.equal(response.status, 200);
  const { data } = await response.json();

  assert.equal(data.templates.length, 1);
  const group = data.templates[0];
  assert.equal(group.id, "tpl-1");
  assert.equal(group.name, "HVAC filter change");
  assert.equal(group.category, "HVAC");
  assert.equal(group.cadence, "monthly");
  assert.equal(group.roundKey, nowRound);
  assert.equal(group.dueDate, `${nowRound}-15`);
  assert.deepEqual(group.tasks, [
    { id: "task-1", unitNumber: "1809 BA-1", status: "pending", completedBy: "", completedAt: null },
    {
      id: "task-2",
      unitNumber: "1809 BA-2",
      status: "done",
      completedBy: "Quinn H",
      completedAt: `${nowRound}-06T12:00:00.000Z`,
    },
  ]);

  // Templates read only the active set; tasks are narrowed to the round keys.
  const [templatesOp, tasksOp] = operations;
  assert.deepEqual(templatesOp.filters, [["active", true]]);
  assert.deepEqual(tasksOp.filters, [
    ["in:template_id", ["tpl-1"]],
    ["in:round_key", [nowRound]],
  ]);
  assert.deepEqual(tasksOp.orderBy, ["unit_number", { ascending: true }]);
});

test("GET with ?round=YYYY-MM pins every template to that round", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      { table: "pm_templates", select: { data: [templateRow()], error: null } },
      {
        table: "pm_tasks",
        select: { data: [taskRow({ round_key: "2026-04", due_date: "2026-04-15" })], error: null },
      },
    ],
    operations,
  );

  const response = await listRoute.GET(listRequest("?round=2026-04"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.templates[0].roundKey, "2026-04");
  assert.deepEqual(operations[1].filters[1], ["in:round_key", ["2026-04"]]);
});

test("GET answers an empty template list without querying tasks", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "pm_templates", select: { data: [], error: null } }],
    operations,
  );

  const response = await listRoute.GET(listRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { templates: [] } });
  assert.equal(operations.length, 1);
});

// --- POST validation ------------------------------------------------------

test("update rejects unknown statuses and malformed bodies without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  for (const body of [{}, { status: "complete" }, { status: 7 }, { status: "done", completedBy: 3 }]) {
    const response = await idRoute.POST(updateRequest(body), idParams);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "Invalid request");
  }

  const noBody = await idRoute.POST(
    new Request("https://emberly-web.test/api/resman/pm-tasks/task-1", { method: "POST" }),
    idParams,
  );
  assert.equal(noBody.status, 400);
});

// --- POST happy paths -----------------------------------------------------

test("checking off stamps completed_at and the provided name", async () => {
  const operations = [];
  const updated = taskRow({ status: "done", completed_by: "Quinn H", completed_at: "2026-07-10T15:00:00.000Z" });
  state.auth = tokenAuth();
  state.db = scriptedSupabase([{ table: "pm_tasks", update: { data: updated, error: null } }], operations);

  const response = await idRoute.POST(updateRequest({ status: "done", completedBy: "Quinn H" }), idParams);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      id: "task-1",
      templateId: "tpl-1",
      roundKey: "2026-07",
      unitNumber: "1809 BA-1",
      status: "done",
      completedBy: "Quinn H",
      completedAt: "2026-07-10T15:00:00.000Z",
    },
  });

  const update = operations[0];
  assert.deepEqual(update.filters, [["id", "task-1"]]);
  assert.equal(update.patch.status, "done");
  assert.equal(update.patch.completed_by, "Quinn H");
  assert.match(update.patch.completed_at, /^20\d{2}-/);
});

test("skipping without a name attributes the token label", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "pm_tasks", update: { data: taskRow({ status: "skipped" }), error: null } }],
    operations,
  );

  const response = await idRoute.POST(updateRequest({ status: "skipped" }), idParams);
  assert.equal(response.status, 200);
  assert.equal(operations[0].patch.status, "skipped");
  assert.equal(operations[0].patch.completed_by, "Marcus Tech");
  assert.match(operations[0].patch.completed_at, /^20\d{2}-/);
});

test("setting a task back to pending clears the completion stamp", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "pm_tasks", update: { data: taskRow(), error: null } }],
    operations,
  );

  const response = await idRoute.POST(updateRequest({ status: "pending", completedBy: "Quinn H" }), idParams);
  assert.equal(response.status, 200);
  assert.deepEqual(operations[0].patch, { status: "pending", completed_by: "", completed_at: null });
});

test("update answers 404 when the task is gone", async () => {
  state.auth = tokenAuth();
  state.db = scriptedSupabase([{ table: "pm_tasks", update: { data: null, error: null } }], []);

  const response = await idRoute.POST(updateRequest({ status: "done" }), idParams);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "PM task not found");
});

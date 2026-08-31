const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

// Same bun:test mock.module harness as tests/admin-username-case.test.js — this
// suite runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = {
  /** What the ResMan portal answers for the attempted login. */
  login: { ok: true, identity: { personName: "Ben Bloch", personId: "person-guid-1" } },
  /** In-memory admin_users table. */
  rows: [],
  /** Per-operation Supabase failures to inject: { lookup, update, insert }. */
  fail: {},
  /** Patches the code managed to persist, so a lost write is visible. */
  updates: [],
};

mock.module("@/lib/resman-admin-login", () => ({
  validateResmanAdminLogin: async () => state.login,
  loginResmanAdminSession: async () => ({ ...state.login, cookies: [] }),
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => stubClient(),
  createUntypedAdminClient: () => stubClient(),
  getMissingSupabaseAdminEnvVars: () => [],
}));

function stubClient() {
  return {
    from: () => {
      let filterCol = null;
      let filterVal = null;
      const api = {
        select: () => api,
        eq: (col, val) => {
          filterCol = col;
          filterVal = val;
          return api;
        },
        maybeSingle: async () => {
          if (state.fail.lookup) return { data: null, error: state.fail.lookup };
          return { data: state.rows.find((r) => r[filterCol] === filterVal) ?? null, error: null };
        },
        single: async () => ({
          data: state.rows.find((r) => r[filterCol] === filterVal) ?? null,
          error: null,
        }),
        insert: (row) => {
          if (state.fail.insert) {
            return {
              select: () => ({ single: async () => ({ data: null, error: state.fail.insert }) }),
            };
          }
          const created = { id: `id-${state.rows.length + 1}`, ...row };
          state.rows.push(created);
          return { select: () => ({ single: async () => ({ data: created, error: null }) }) };
        },
        update: (patch) => ({
          eq: async (col, val) => {
            if (state.fail.update) return { data: null, error: state.fail.update };
            const row = state.rows.find((r) => r[col] === val);
            if (row) Object.assign(row, patch);
            state.updates.push(patch);
            return { data: null, error: null };
          },
        }),
      };
      return api;
    },
  };
}

const { authenticateResmanAdmin } = require("../lib/admin-users");

/** Run a login with console.error captured, so the operator log is assertable. */
async function loginCapturingLogs(username, password) {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args);
  try {
    return { result: await authenticateResmanAdmin(username, password), logs };
  } finally {
    console.error = original;
  }
}

function reset() {
  state.rows = [];
  state.fail = {};
  state.updates = [];
  state.login = { ok: true, identity: { personName: "Ben Bloch", personId: "person-guid-1" } };
}

test("a local-database lookup failure is not reported as a ResMan failure", async () => {
  reset();
  state.fail.lookup = { code: "PGRST205", message: "schema cache" };

  const { result, logs } = await loginCapturingLogs("bbloch", "pw");

  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /admin_users lookup/);
  assert.equal(logs.length, 1, "the failure must be logged for an operator");
  assert.match(logs[0][0], /admin_users lookup/);
  assert.equal(logs[0][1].code, "PGRST205");
});

test("a failed identity write fails the login instead of losing the person GUID", async () => {
  // The update carries resman_person_id — every work-order attribution is keyed
  // on it. Unchecked, the write vanished and the caller was still handed the
  // personId as if it had been stored.
  reset();
  state.rows = [
    {
      id: "id-1",
      resman_username: "bbloch",
      role: "viewer",
      display_name: "bbloch",
      resman_person_id: null,
    },
  ];
  state.fail.update = { code: "40001", message: "could not serialize access" };

  const { result, logs } = await loginCapturingLogs("bbloch", "pw");

  assert.equal(result.ok, false, "a lost person GUID must not read as a clean sign-in");
  assert.match(result.detail ?? "", /admin_users update/);
  assert.equal(state.rows[0].resman_person_id, null, "the GUID really did not persist");
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].code, "40001");
});

test("a failed insert names the database, and no log carries the password", async () => {
  reset();
  state.fail.insert = { code: "23505", message: "duplicate key" };

  const { result, logs } = await loginCapturingLogs("bbloch", "hunter2");

  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /admin_users insert/);
  const logged = JSON.stringify(logs);
  assert.ok(!logged.includes("hunter2"), "credentials must never reach the logs");
  assert.ok(logged.includes("bbloch"), "the username identifies the failed sign-in");
});

test("a healthy sign-in keeps its result shape and logs nothing", async () => {
  reset();

  const { result, logs } = await loginCapturingLogs("bbloch", "pw");

  assert.equal(result.ok, true);
  assert.equal(result.personId, "person-guid-1");
  assert.equal(result.admin.displayName, "Ben Bloch");
  assert.equal(logs.length, 0);
});

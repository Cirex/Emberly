const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

// Same bun:test mock.module harness as tests/manager-snapshots.test.js — this
// suite runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = {
  /** What the ResMan portal answers for the attempted login. */
  login: null,
  /** In-memory admin_users table. */
  rows: [],
  /** Every insert the code attempted, so a duplicate is visible as an insert. */
  inserts: [],
};

mock.module("@/lib/resman-admin-login", () => ({
  // ResMan authenticates case-insensitively — that is the whole premise. It
  // accepts whatever spelling is typed and answers with the same identity.
  validateResmanAdminLogin: async () => state.login,
  // admin-users also imports the cookie-returning variant; unused here.
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
        eq: (col, val) => { filterCol = col; filterVal = val; return api; },
        // The real column is unique, so a case-sensitive match is exactly what
        // the database would do.
        maybeSingle: async () => ({
          data: state.rows.find((r) => r[filterCol] === filterVal) ?? null,
          error: null,
        }),
        single: async () => ({ data: state.rows.find((r) => r[filterCol] === filterVal) ?? null, error: null }),
        insert: (row) => {
          state.inserts.push(row);
          const created = { id: `id-${state.rows.length + 1}`, ...row };
          state.rows.push(created);
          return {
            select: () => ({ single: async () => ({ data: created, error: null }) }),
          };
        },
        update: (patch) => ({
          eq: async (col, val) => {
            const row = state.rows.find((r) => r[col] === val);
            if (row) Object.assign(row, patch);
            return { data: null, error: null };
          },
        }),
      };
      return api;
    },
  };
}

const { authenticateResmanAdmin, normalizeResmanUsername } = require("../lib/admin-users");

function resmanIdentity() {
  return { ok: true, identity: { personName: "Rebeca de Ojeda", personId: "person-guid-1" } };
}

test("normalizeResmanUsername lowercases and trims", () => {
  assert.equal(normalizeResmanUsername("  Rdeojeda "), "rdeojeda");
  assert.equal(normalizeResmanUsername("RDEOJEDA"), "rdeojeda");
  assert.equal(normalizeResmanUsername("rdeojeda"), "rdeojeda");
});

test("a different spelling signs into the SAME admin row", async () => {
  // The bug: ResMan accepts `rdeojeda` and `Rdeojeda` as one person, but we
  // keyed on the raw string, so the second spelling missed the lookup and
  // inserted a second row — with its own id and its own ROLE. Whichever
  // spelling someone typed decided what they could see.
  state.rows = [];
  state.inserts = [];
  state.login = resmanIdentity();

  const first = await authenticateResmanAdmin("rdeojeda", "pw");
  assert.equal(first.ok, true);

  const second = await authenticateResmanAdmin("Rdeojeda", "pw");
  assert.equal(second.ok, true);

  assert.equal(state.inserts.length, 1, "the second spelling must not create a row");
  assert.equal(state.rows.length, 1);
  assert.equal(second.admin.adminId, first.admin.adminId, "same account, same permissions");
});

test("the stored username is canonical regardless of what was typed", async () => {
  state.rows = [];
  state.inserts = [];
  state.login = resmanIdentity();

  await authenticateResmanAdmin("  RDeoJeda  ", "pw");
  assert.equal(state.inserts[0].resman_username, "rdeojeda");
});

test("a role granted to one spelling applies to every spelling", async () => {
  // The consequence that makes this an authorization bug rather than a cosmetic
  // one: elevating the account must not be undone by typing a capital letter.
  state.rows = [];
  state.inserts = [];
  state.login = resmanIdentity();

  await authenticateResmanAdmin("rdeojeda", "pw");
  state.rows[0].role = "property_manager";

  const again = await authenticateResmanAdmin("RDEOJEDA", "pw");
  assert.equal(again.admin.role, "property_manager", "the grant survives a different spelling");
});

test("failed ResMan authentication still creates nothing", async () => {
  state.rows = [];
  state.inserts = [];
  state.login = { ok: false, reason: "invalid_credentials" };

  const result = await authenticateResmanAdmin("Rdeojeda", "wrong");
  assert.equal(result.ok, false);
  assert.equal(state.inserts.length, 0);
});

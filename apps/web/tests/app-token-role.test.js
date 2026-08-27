const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

/**
 * Which SCOPED role /api/admin/auth/app-token mints for each native app.
 *
 * The maintenance app used to receive `security_manager` because that role
 * happened to carry the right capability set (units, work-orders) — but the
 * name read as a permissions bug in the app UI and muddied audits. New
 * maintenance sign-ins now mint `maintenance_tech`; `security_manager` is NOT
 * retired (scanners, back-office humans, and legacy maintenance tokens all
 * still carry it), so this suite pins the mint, not the acceptance gates —
 * those are covered by tests/manager-route-authz.test.js.
 *
 * Same bun:test mock.module harness as tests/pm-tasks.test.js — this suite
 * runs in its own process (the package.json `test` script runs each file
 * separately), so the process-global mocks cannot leak into other files. Only
 * AUTHENTICATION and persistence are stubbed: the scopes each role is pinned
 * to come from the real policy in lib/app-role-capabilities.ts.
 */

const state = {
  /** Arguments of the last mintAccessToken call. */
  minted: null,
};

const FAKE_COOKIES = [
  { name: "s", value: "v", domain: "multisouth.myresman.com", path: "/", expires: null },
];

mock.module("@/lib/admin-users", () => ({
  authenticateResmanAdminSession: async () => ({
    ok: true,
    admin: { adminId: "admin-7", role: "property_manager", displayName: "Marcus Tech" },
    personId: "person-9",
    resmanCookies: FAKE_COOKIES,
  }),
}));
mock.module("@/lib/rate-limit", () => ({
  checkRateLimit: async () => true,
}));
mock.module("@/lib/supabase/admin", () => ({
  createUntypedAdminClient: () => ({}),
  createAdminClient: () => ({}),
  getMissingSupabaseAdminEnvVars: () => [],
}));
mock.module("@/lib/access-tokens", () => ({
  mintAccessToken: async (_client, input) => {
    state.minted = input;
    return { token: "eapi_test_plaintext", id: "token-1" };
  },
}));
// Real policy, not the full resman-api-auth module (which drags in Supabase):
// the route only imports appRoleScopes, and app-role-capabilities is where it
// actually lives.
mock.module("@/lib/resman-api-auth", () => ({
  appRoleScopes: require("../lib/app-role-capabilities").appRoleScopes,
}));

const route = require("../app/api/admin/auth/app-token/route.ts");

function signIn(body) {
  state.minted = null;
  return route.POST(
    new Request("https://emberly.test/api/admin/auth/app-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("maintenance response carries the ResMan session; manager's does not", async () => {
  const maint = await signIn({ username: "marcus", password: "pw", app: "maintenance" });
  assert.equal(maint.status, 200);
  assert.deepEqual((await maint.json()).resmanSession, { cookies: FAKE_COOKIES });

  const mgr = await signIn({ username: "marcus", password: "pw", app: "manager" });
  assert.equal(mgr.status, 200);
  assert.equal((await mgr.json()).resmanSession, undefined);
});

test("the maintenance app mints maintenance_tech, pinned to its own scopes", async () => {
  const response = await signIn({ username: "marcus", password: "pw", app: "maintenance" });
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.admin.role, "maintenance_tech");
  assert.equal(state.minted.role, "maintenance_tech");
  assert.deepEqual([...state.minted.scopes].sort(), ["units", "work-orders"]);
});

test("installs that predate the app field are maintenance builds and mint maintenance_tech", async () => {
  const response = await signIn({ username: "marcus", password: "pw" });
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.admin.role, "maintenance_tech");
  assert.equal(state.minted.role, "maintenance_tech");
});

test("the manager app still mints property_manager with the manager scopes", async () => {
  const response = await signIn({ username: "marcus", password: "pw", app: "manager" });
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.admin.role, "property_manager");
  assert.equal(state.minted.role, "property_manager");
  const { appRoleScopes } = require("../lib/app-role-capabilities");
  assert.deepEqual([...state.minted.scopes].sort(), [...appRoleScopes("property_manager")].sort());
});

test("no app ever receives the person's back-office role or security_manager", async () => {
  for (const app of ["maintenance", "manager", ""]) {
    const response = await signIn({ username: "marcus", password: "pw", app });
    assert.equal(response.status, 200);
    assert.notEqual(state.minted.role, "security_manager");
    assert.notEqual(state.minted.role, "super_admin");
  }
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

/**
 * The bespoke staff surfaces — /api/resman/manager/* and /api/resman/pm-tasks —
 * do not go through the generic resource router, so they carry their own
 * authorization. Every one of them used to be written as:
 *
 *     if (auth.kind === "scanner") return 403;
 *
 * which reads as "staff only" but is not. A native-app token authenticates as
 * `kind: "token"`, so the maintenance app's own credential — the one sitting in
 * the Keychain of every tech's phone — passed straight through to the rent
 * ledger, the delinquency list, lease terms, MLGW billing, and the resident
 * roster with birthdates and income.
 *
 * Two suites here. The first pins the behaviour of the shared guard; the second
 * scans the routes on disk, so a NEW manager route added next year cannot
 * quietly reintroduce the weak check.
 */

// ── harness ────────────────────────────────────────────────────────────────

const state = { subject: null, scanner: false };

mock.module("@/lib/access-tokens", () => ({
  authenticateAccessToken: async () => state.subject,
}));
mock.module("@/lib/scanner-auth", () => ({
  hasScannerCredential: () => state.scanner,
  authenticateScanner: async () => (state.scanner ? { id: "scanner-1" } : null),
}));
mock.module("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
mock.module("@/lib/supabase/admin", () => ({
  createUntypedAdminClient: () => ({}),
  createAdminClient: () => ({}),
  getMissingSupabaseAdminEnvVars: () => [],
}));

const { appRoleScopes, requireStaffToken } = require("../lib/resman-api-auth");

function request() {
  return new Request("https://emberly.test/api/resman/manager/ledger", {
    headers: { Authorization: "Bearer eapi_test" },
  });
}

function asRole(role, scopes) {
  state.scanner = false;
  state.subject = { role, scopes: scopes ?? appRoleScopes(role), label: "t", id: "1" };
}

/** Every capability the manager app's screens sit behind. */
const MANAGER_CAPABILITIES = [
  "manager:people",
  "manager:ledger",
  "manager:delinquency",
  "manager:leases",
  "manager:insurance",
  "manager:mlgw",
  "manager:renewals",
  "manager:reports",
  "manager:snapshots",
];

// ── behaviour ──────────────────────────────────────────────────────────────

// Two maintenance roles on purpose: new sign-ins mint `maintenance_tech`,
// while tokens minted before that role existed still carry `security_manager`
// and must keep working identically.
const MAINTENANCE_ROLES = ["maintenance_tech", "security_manager"];

test("a maintenance token reaches NO manager capability", async () => {
  for (const role of MAINTENANCE_ROLES) {
    asRole(role);
    for (const capability of MANAGER_CAPABILITIES) {
      const result = await requireStaffToken(request(), capability);
      assert.equal(result.ok, false, `${role} was allowed ${capability}`);
      assert.equal(result.response.status, 403);
    }
  }
});

test("a maintenance token still reaches its own surface", async () => {
  for (const role of MAINTENANCE_ROLES) {
    asRole(role);
    for (const capability of ["units", "work-orders"]) {
      const result = await requireStaffToken(request(), capability);
      assert.equal(result.ok, true, `${role} was denied ${capability}`);
    }
  }
});

test("live maintenance tokens minted before the manager role keep PM rounds", async () => {
  // Tokens already in the Keychain carry the original pinned scopes. PM tasks
  // are gated on `work-orders` precisely so those installs keep working without
  // a forced re-sign-in.
  asRole("security_manager", ["units", "work-orders"]);
  const result = await requireStaffToken(request(), "work-orders");
  assert.equal(result.ok, true);
});

test("a manager token reaches every manager capability", async () => {
  asRole("property_manager");
  for (const capability of MANAGER_CAPABILITIES) {
    const result = await requireStaffToken(request(), capability);
    assert.equal(result.ok, true, `property_manager was denied ${capability}`);
  }
});

test("a manager token does not inherit the admin surface", async () => {
  asRole("property_manager");
  for (const capability of ["residents", "transactions", "guest-passes"]) {
    const result = await requireStaffToken(request(), capability);
    assert.equal(result.ok, false, `property_manager was allowed ${capability}`);
  }
});

test("a back-office token with no scopes is unrestricted", async () => {
  asRole("staff", []);
  for (const capability of MANAGER_CAPABILITIES) {
    const result = await requireStaffToken(request(), capability);
    assert.equal(result.ok, true, `staff was denied ${capability}`);
  }
});

test("a deliberately narrowed back-office token stays narrowed", async () => {
  asRole("staff", ["units"]);
  const result = await requireStaffToken(request(), "manager:ledger");
  assert.equal(result.ok, false);
});

test("a scanner credential is refused outright", async () => {
  state.subject = null;
  state.scanner = true;
  const result = await requireStaffToken(request(), "manager:ledger");
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
});

test("an unauthenticated caller gets 401, not 403", async () => {
  state.subject = null;
  state.scanner = false;
  const result = await requireStaffToken(request(), "manager:ledger");
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
});

// ── the routes on disk ─────────────────────────────────────────────────────

const STAFF_ROOTS = [
  path.join(__dirname, "..", "app", "api", "resman", "manager"),
  path.join(__dirname, "..", "app", "api", "resman", "pm-tasks"),
  // Completion photos are pictures of the inside of a resident's home. These
  // routes accepted ANY authenticated caller, which included a gate scanner —
  // a shared credential on a wall could stream them and DELETE them. The
  // upload route looked like it checked (it passed `auth.kind === "scanner"`
  // into getResource) but that only narrows when the resource declares
  // `scannerVisible`, and work-orders deliberately doesn't.
  path.join(__dirname, "..", "app", "api", "resman", "work-order-photos"),
];

/** Individual staff routes outside the roots above. */
const STAFF_FILES = [
  path.join(__dirname, "..", "app", "api", "resman", "work-orders", "[id]", "photos", "route.ts"),
];

function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

test("every staff route authorizes through requireStaffToken", () => {
  const files = [...STAFF_ROOTS.flatMap(routeFiles), ...STAFF_FILES];
  // Guards against a mistyped path silently making this suite vacuous.
  assert.ok(files.length >= 22, `expected the staff surface, found ${files.length} routes`);

  const offenders = [];
  const allowed = new Set([
    ...appRoleScopes("property_manager"),
    ...appRoleScopes("security_manager"),
    ...appRoleScopes("maintenance_tech"),
  ]);

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(path.join(__dirname, ".."), file);

    if (source.includes("requireResmanApiKey")) {
      offenders.push(`${rel}: still calls requireResmanApiKey directly`);
    }
    if (/auth\.kind === "scanner"/.test(source)) {
      offenders.push(`${rel}: still hand-rolls the scanner-only check`);
    }

    const capabilities = [...source.matchAll(/requireStaffToken\(request,\s*"([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    if (capabilities.length === 0) {
      offenders.push(`${rel}: no requireStaffToken call`);
    }
    // A capability no app role grants is a typo. It fails closed, but it would
    // lock the manager app out of a screen with no other signal.
    for (const capability of capabilities) {
      if (!allowed.has(capability)) offenders.push(`${rel}: unknown capability "${capability}"`);
    }

    // One guard per exported handler — an unguarded second method on a route is
    // exactly how these things get missed.
    const handlers = [...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)];
    if (handlers.length !== capabilities.length) {
      offenders.push(
        `${rel}: ${handlers.length} handler(s) but ${capabilities.length} guard(s)`,
      );
    }
  }

  assert.deepEqual(offenders, []);
});

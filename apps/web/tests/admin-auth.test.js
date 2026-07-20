process.env.API_SECRET_KEY = "admin-secret";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret";
// The admin key header is now the off-by-default break-glass key (the shared
// ADMIN_LOGIN_KEY was retired in favour of ResMan staff login).
process.env.ADMIN_BREAKGLASS_KEY = "admin-secret";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAdminSessionToken,
  verifyAdminKey,
  verifyAdminRequest,
} = require("../lib/auth");

test("verifyAdminKey accepts the explicit break-glass admin header", async () => {
  const request = new Request("https://emberly.test/api/admin/residents", {
    headers: { "x-admin-key": "admin-secret" },
  });

  assert.equal(await verifyAdminKey(request), true);
});

test("verifyAdminKey accepts the signed httpOnly admin session cookie sent by same-origin fetch", async () => {
  const token = createAdminSessionToken({ now: Date.now() });
  const request = new Request("https://emberly.test/api/admin/residents", {
    headers: { cookie: `other=value; emberly_admin_session=${token}` },
  });

  assert.equal(await verifyAdminKey(request), true);
});

test("verifyAdminRequest returns admin identity and role from signed sessions", async () => {
  const token = createAdminSessionToken({
    adminId: "admin-1",
    role: "security_manager",
    displayName: "Security Manager",
    now: Date.parse("2026-06-24T12:00:00.000Z"),
  });
  const request = new Request("https://emberly.test/api/admin/scanners", {
    headers: { cookie: `emberly_admin_session=${token}` },
  });

  assert.deepEqual(await verifyAdminRequest(request, Date.parse("2026-06-24T12:01:00.000Z")), {
    adminId: "admin-1",
    role: "security_manager",
    displayName: "Security Manager",
  });
});

test("verifyAdminRequest treats the bootstrap admin key as super admin", async () => {
  const request = new Request("https://emberly.test/api/admin/residents", {
    headers: { "x-admin-key": "admin-secret" },
  });

  assert.deepEqual(await verifyAdminRequest(request), {
    adminId: "bootstrap-admin",
    role: "super_admin",
    displayName: "Bootstrap Admin",
  });
});

test("failed x-admin-key attempts are rate limited without throttling valid keys", async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.equal(
      await verifyAdminKey(new Request("https://emberly.test/api/admin/residents", {
        headers: { "x-admin-key": "wrong-key", "x-forwarded-for": "203.0.113.9" },
      })),
      false
    );
  }

  assert.equal(
    await verifyAdminKey(new Request("https://emberly.test/api/admin/residents", {
      headers: { "x-admin-key": "admin-secret", "x-forwarded-for": "203.0.113.9" },
    })),
    true
  );
});

test("verifyAdminKey rejects the legacy raw admin key cookie", async () => {
  const request = new Request("https://emberly.test/api/admin/residents", {
    headers: {
      "x-admin-key": "",
      cookie: "emberly_admin_key=admin-secret",
    },
  });

  assert.equal(await verifyAdminKey(request), false);
});

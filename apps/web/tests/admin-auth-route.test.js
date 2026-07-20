process.env.API_SECRET_KEY = "api-secret-for-route-tests";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-for-route-tests";
// Admin login is ResMan staff credentials; the key path is now the off-by-default
// break-glass key (posted as `breakGlass`, not `key`).
process.env.ADMIN_BREAKGLASS_KEY = "correct-admin-key";


const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const originalResolveFilename = Module._resolveFilename;
const projectRoot = path.resolve(__dirname, "..");
Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(
      this,
      path.join(projectRoot, request.slice(2)),
      parent,
      isMain,
      options
    );
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const { POST } = require("../app/api/admin/auth/route");

test("admin break-glass login redirects with a relative location after setting the session cookie", async () => {
  const response = await POST(new Request("http://192.168.1.181:3001/api/admin/auth", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "198.51.100.25",
    },
    body: new URLSearchParams({ breakGlass: "correct-admin-key" }),
  }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin");
  assert.match(response.headers.get("set-cookie") ?? "", /emberly_admin_session=/);
});

test("admin form login errors redirect back to the submitted login page", async () => {
  const response = await POST(new Request("http://localhost:3000/api/admin/auth", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "198.51.100.26",
    },
    body: new URLSearchParams({ breakGlass: "wrong-admin-key", returnTo: "/" }),
  }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/?error=invalid");
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

/**
 * Every WRITE handler under /api/admin must name the roles allowed to perform it.
 *
 * `requireAdmin(request)` with no options authenticates and stops there — any
 * admin row passes, including `viewer`, a role whose entire meaning is
 * read-only. Thirteen write handlers were in that state. Two mattered
 * immediately:
 *
 *   - mcp-tokens/[id] DELETE revokes an access token. Its POST already required
 *     super_admin, but the DELETE did not — so the least-privileged account in
 *     the system held a kill switch on every API/MCP integration and every
 *     signed-in native app.
 *   - map-cameras POST/PATCH/DELETE place and remove property cameras.
 *
 * A scanner credential is represented as security_manager
 * (admin-request.ts SCANNER_ADMIN_ROLE) and super_admin passes implicitly via
 * adminHasRole, so gating on the non-viewer roles keeps the field apps and gate
 * devices working while closing the hole.
 */

const ADMIN_ROOT = path.join(__dirname, "..", "app", "api", "admin");
const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** Handler bodies keyed by method, split on the export boundary. */
function handlers(source) {
  const parts = source.split(/\nexport async function (GET|POST|PATCH|PUT|DELETE)\b/);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ method: parts[i], body: parts[i + 1] });
  return out;
}

test("no admin write handler authenticates without naming allowed roles", () => {
  const files = routeFiles(ADMIN_ROOT);
  // A mistyped path would otherwise make this suite pass vacuously.
  assert.ok(files.length >= 20, `expected the admin surface, found ${files.length} routes`);

  const offenders = [];
  let checked = 0;

  for (const file of files) {
    const rel = path.relative(path.join(__dirname, ".."), file);
    for (const { method, body } of handlers(readFileSync(file, "utf8"))) {
      if (!WRITE_METHODS.includes(method)) continue;
      const match = /await (requireAdmin|requireAdminOrScanner)\(request([^)]*)\)/.exec(body);
      // Routes guarded some other way (cron bearer, resman api key) are not in
      // scope here — only the two admin-session guards take a roles option.
      if (!match) continue;
      checked += 1;
      if (!match[2].includes("roles")) {
        offenders.push(`${rel} ${method}: ${match[1]}(request) with no roles option`);
      }
    }
  }

  // If this drops to zero the regex stopped matching and the test means nothing.
  assert.ok(checked >= 10, `expected to check several write handlers, checked ${checked}`);
  assert.deepEqual(offenders, []);
});

test("revoking an access token is super_admin work, like minting one", () => {
  const mint = readFileSync(path.join(ADMIN_ROOT, "mcp-tokens", "route.ts"), "utf8");
  const revoke = readFileSync(path.join(ADMIN_ROOT, "mcp-tokens", "[id]", "route.ts"), "utf8");
  for (const [label, source] of [["mint", mint], ["revoke", revoke]]) {
    assert.match(
      source,
      /roles:\s*\["super_admin"\]/,
      `${label} should be gated on super_admin`,
    );
  }
});

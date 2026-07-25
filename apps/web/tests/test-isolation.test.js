const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

/**
 * These suites REQUIRE one process per file, and that requirement is invisible.
 *
 * Two process-global things are in play:
 *
 *   - `process.env` writes at module scope. Nine files set API_SECRET_KEY,
 *     ADMIN_SESSION_SECRET, SCANNER_API_KEY and friends before importing the
 *     code under test — and they set them to DIFFERENT values (API_SECRET_KEY
 *     alone is "admin-secret", "api-secret-for-tests", "test-secret" and
 *     "api-secret-for-route-tests" across four files). In one process the last
 *     import wins for everybody.
 *   - `mock.module` replaces a module for the whole process. A suite that stubs
 *     `@/lib/api/work-orders` or `@react-native-async-storage/async-storage`
 *     silently rewires every later file.
 *
 * Neither shows up as a clear error — you get a failure in an unrelated suite
 * that passes when run alone, which is the worst kind of test failure to chase.
 * That is exactly what happened: `bun test` reported a failure in the sign-out
 * purge suite that came from a different file's mock.
 *
 * The fix is the per-file runner in package.json. This test stops someone from
 * "simplifying" it back to a bare `bun test` and quietly reintroducing the
 * bleed — in this package and in the three app packages, which have the same
 * hazard and the same runner.
 */

const REPO = path.join(__dirname, "..", "..", "..");
const PACKAGES = [
  path.join(REPO, "apps", "web"),
  path.join(REPO, "apps", "maintenance"),
  path.join(REPO, "apps", "manager"),
  path.join(REPO, "apps", "security"),
];

test("every test-bearing package runs its suites one file per process", () => {
  const offenders = [];
  for (const pkgDir of PACKAGES) {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const script = pkg.scripts?.test ?? "";
    const name = path.basename(pkgDir);
    // The shape that matters: a loop over files, invoking bun test per file.
    const perFile = /for\s+f\s+in\s+tests\//.test(script) && /bun test "\$f"/.test(script);
    if (!perFile) {
      offenders.push(`${name}: test script is not a per-file loop — got: ${script}`);
    }
    // And it must not swallow failures.
    if (!/exit \$e/.test(script)) {
      offenders.push(`${name}: test script does not propagate a non-zero exit`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the env writes this guards are really there, at module scope", () => {
  // If these disappear (someone moves them into beforeEach, which would be the
  // proper fix), this test should be revisited rather than left asserting
  // something that no longer describes the code.
  const dir = __dirname;
  const withModuleScopeEnv = readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .filter((f) => /^process\.env\./m.test(readFileSync(path.join(dir, f), "utf8")));
  // Four today: security-hardening, admin-auth, admin-auth-route,
  // resident-session. (map-sync writes env too, but inside test bodies.)
  assert.ok(
    withModuleScopeEnv.length >= 4,
    `expected several suites to set env at module scope, found ${withModuleScopeEnv.length}`,
  );

  // And that at least one variable genuinely conflicts across files — the
  // conflict is the whole reason isolation is mandatory, not just tidy.
  const values = new Set();
  for (const f of withModuleScopeEnv) {
    const src = readFileSync(path.join(dir, f), "utf8");
    const m = /^process\.env\.API_SECRET_KEY\s*=\s*(.+)$/m.exec(src);
    if (m) values.add(m[1].trim());
  }
  // Four files, four DIFFERENT values. In a shared process the last import
  // wins for all of them, which is why isolation is mandatory here rather than
  // merely tidy.
  assert.ok(
    values.size >= 2,
    `expected conflicting API_SECRET_KEY values across suites, found ${values.size}`,
  );
});

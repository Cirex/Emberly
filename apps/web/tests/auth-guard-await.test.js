const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

/**
 * Every auth guard in lib/auth.ts and lib/resman-api-auth.ts is `async`. Calling
 * one without `await` returns a Promise — which is ALWAYS truthy — so a guard
 * written as `if (!guard(request))` silently never rejects and the route is
 * open to the internet.
 *
 * That is not hypothetical: /api/cron/cleanup shipped with
 * `if (!hasCronBearer(request) && !verifyAdminKey(request))`, which made its
 * 401 unreachable. TypeScript does not catch it (a Promise is a valid operand
 * of `!`), and neither does lint, so this scan is the guard.
 */

const API_ROOT = path.join(__dirname, "..", "app", "api");

/** Guards that return a Promise and must therefore always be awaited. */
const ASYNC_GUARDS = [
  "verifyAdminKey",
  "verifyAdminRequest",
  "verifyResidentDeviceSession",
  "verifyResmanPortalAccess",
  "requireAdmin",
  "requireAdminOrScanner",
  "requireResmanApiKey",
  "requireStaffToken",
];

function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

test("no API route calls an async auth guard without awaiting it", () => {
  const offenders = [];

  for (const file of routeFiles(API_ROOT)) {
    const source = readFileSync(file, "utf8");
    source.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      for (const guard of ASYNC_GUARDS) {
        // A call to the guard that is not preceded by `await` on the same line.
        // Matches `!guard(`, `= guard(`, `(guard(` — but not `await guard(`
        // and not the import/definition lines.
        const called = new RegExp(`(^|[^.\\w])${guard}\\s*\\(`).test(code);
        if (!called) continue;
        if (/\bimport\b|\bfunction\b|\bexport\b/.test(code)) continue;
        const awaited = new RegExp(`await\\s+${guard}\\s*\\(`).test(code);
        if (!awaited) {
          offenders.push(
            `${path.relative(API_ROOT, file)}:${i + 1} — ${guard}() not awaited: ${code.trim()}`,
          );
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Async auth guard(s) used without await — these routes do NOT reject:\n${offenders.join("\n")}`,
  );
});

test("the scan actually sees the routes (guards against a silent zero-file pass)", () => {
  // A path typo would make the test above pass vacuously forever.
  assert.ok(routeFiles(API_ROOT).length > 50, "expected to scan the full route tree");
});

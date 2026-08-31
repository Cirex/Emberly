const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Every script path a script names must exist.
 *
 * The .ts -> .mjs port left two scripts spawning siblings by their OLD name:
 * eas-release called eas-env-sync.ts and release called eas-release.ts. Nothing
 * caught it, because these are runtime STRINGS — tsc cannot see them and no
 * test ran them. It surfaced as a release failing at the env-sync step, after
 * the preflight had already passed, which is the worst moment to discover it.
 *
 * Usage/help text is checked too: those lines get copied straight into a
 * terminal, so a stale one is a broken command handed to whoever is shipping.
 */
const SCRIPTS_DIR = path.join(__dirname, "..");
const files = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".mjs"));

test("scripts spawn siblings that actually exist", () => {
  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), "utf8");
    // path.join(import.meta.dir, "sibling.mjs")
    for (const m of source.matchAll(/import\.meta\.dir,\s*"([^"]+)"/g)) {
      if (!fs.existsSync(path.join(SCRIPTS_DIR, m[1]))) missing.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `scripts reference siblings that do not exist:\n${missing.join("\n")}`);
});

test("usage text names commands that can actually be run", () => {
  // Only paths under scripts/ — references to real source files elsewhere in
  // the repo (apps/web/lib/resman-api.ts, route.ts) are legitimate.
  const broken = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), "utf8");
    for (const m of source.matchAll(/scripts\/([a-z0-9-]+\.[a-z]+)/g)) {
      if (!fs.existsSync(path.join(SCRIPTS_DIR, m[1]))) broken.push(`${file}: scripts/${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `usage text names missing scripts:\n${broken.join("\n")}`);
});

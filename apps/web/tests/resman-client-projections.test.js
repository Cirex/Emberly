const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..", "..");
const RESOURCES = fs.readFileSync(path.join(REPO, "apps/web/lib/resman-resources.ts"), "utf8");

/**
 * Every mobile client that reads a resource with a curated `defaultColumns`
 * must send a `columns` projection.
 *
 * This is a whole-class guard, not a spot check. `resolveProjection` answers an
 * unprojected request with the resource's `defaultColumns` — a deliberately
 * narrow subset — while the clients' Zod schemas declare the WIDE row and give
 * every field a `.default()` or `.optional()`. The two combine into the worst
 * failure this layer has: the response is shaped exactly like the contract, it
 * parses without a single error, and half the data is silently absent.
 *
 * It reached production in five places at once — blank work-order descriptions
 * and technician notes in maintenance, missing street addresses and a dead
 * "Last synced" label in security, and a manager delinquency heat map with no
 * balance columns — and nothing anywhere logged a word about it.
 */

/** defaultColumns / selectColumns for every resource that curates a default. */
function resourcesWithDefaults() {
  const out = {};
  const re = /export const (\w+) = defineResource\(\{([\s\S]*?)\n\}\);/g;
  for (let m; (m = re.exec(RESOURCES)); ) {
    const body = m[2];
    const name = /name:\s*"([^"]+)"/.exec(body);
    if (!name) continue;
    const list = (key) => {
      const mm = new RegExp(key + ":\\s*\\[([\\s\\S]*?)\\]").exec(body);
      return mm ? [...mm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    };
    const def = list("defaultColumns");
    if (def.length > 0) out[name[1]] = { default: def, public: list("selectColumns") };
  }
  return out;
}

/** Client modules that list one of those resources, and the schema they parse with. */
const CLIENTS = [
  ["apps/security/lib/api/units.ts", "units"],
  ["apps/maintenance/lib/api/units.ts", "units"],
  ["apps/manager/lib/api/units.ts", "units"],
  ["apps/maintenance/lib/api/work-orders.ts", "work-orders"],
  ["apps/manager/lib/api/work-orders.ts", "work-orders"],
];

const resources = resourcesWithDefaults();

test("the resource table still curates defaults (otherwise this guard is moot)", () => {
  assert.ok(Object.keys(resources).length >= 4, `found ${Object.keys(resources).length}`);
  assert.ok(resources["units"], "units should curate a default");
  assert.ok(resources["work-orders"], "work-orders should curate a default");
});

for (const [rel, resourceName] of CLIENTS) {
  const file = path.join(REPO, rel);

  test(`${rel} sends a column projection`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /q\.set\("columns",/,
      "an unprojected read gets defaultColumns, and this module's schema wants more",
    );
  });

  test(`${rel} derives the projection from the schema it parses with`, () => {
    // A hand-typed list is the same bug with extra steps: it drifts the moment
    // a field is added to the schema and not to the string.
    const src = fs.readFileSync(file, "utf8");
    const derived = /const COLUMNS = Object\.keys\((\w+)\.shape\)\.join\(","\)/.exec(src);
    assert.ok(derived, "expected COLUMNS to be derived from the Zod schema's shape");
    assert.match(src, new RegExp(`export const ${derived[1]} = z\\.object\\(`));
  });

  test(`${rel} actually needs it — its schema declares withheld columns`, () => {
    // Proves the guard is pointed at a real gap rather than asserting a habit.
    const src = fs.readFileSync(file, "utf8");
    const obj = /z\.object\(\{([\s\S]*?)\n\}\)/.exec(src);
    assert.ok(obj, "no z.object found");
    const fields = [...obj[1].matchAll(/^ {2}([a-z_][a-z0-9_]*):/gm)].map((m) => m[1]);
    const { default: def, public: pub } = resources[resourceName];
    const withheld = fields.filter((f) => pub.includes(f) && !def.includes(f));
    assert.ok(
      withheld.length > 0,
      `${rel} declares nothing outside defaultColumns — drop it from CLIENTS`,
    );
  });
}

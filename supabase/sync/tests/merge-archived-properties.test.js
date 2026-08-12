const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_PATH = path.join(__dirname, "..", "src", "run-merge-archived-properties.ts");
const RULES_PATH = path.join(__dirname, "..", "src", "resman", "merge-archived.ts");
const SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");

/**
 * The one-off merge of three archived ResMan properties into the property we use
 * now. Two failure modes are worth a permanent test, because both are silent:
 *
 *   1. A delete-missing pass. The script writes a fraction of the write scope,
 *      so every live row would look "missing". upsertMirror's 0.35 floor guard
 *      would refuse it, but a guard is not a design.
 *   2. Overwriting a live unit with an archived snapshot. The archived reports
 *      are frozen; upserting one over a current row pushes stale occupancy and
 *      tenant names into the apps and reads as a sync failure.
 */

test("no delete-missing anywhere in the merge script", () => {
  assert.doesNotMatch(
    SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
    /deleteMissing|deleteScope/,
    "the merge writes a subset of the write scope — a delete-missing pass would " +
      "target every live row that was not in the archived report",
  );
});

test("the dry run is the default and --apply is the only way to write", () => {
  const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.match(stripped, /const apply = process\.argv\.includes\("--apply"\)/);
  // Every upsertMirror call must sit behind the apply gate.
  const upsertCount = (stripped.match(/upsertMirror\(/g) ?? []).length;
  const gatedCount = (stripped.match(/if \(apply &&/g) ?? []).length;
  assert.equal(
    upsertCount,
    gatedCount,
    `${upsertCount} upsertMirror call(s) but only ${gatedCount} apply gate(s)`,
  );
});

test("the scraped property id is overwritten with the write property", () => {
  assert.match(
    SOURCE,
    /mapped\.resman_property_id = writePropertyId/,
    "mapAllUnitsRow takes resman_property_id from the CSV's own PropertyID column, " +
      "so it must be forced afterwards rather than passed as the default",
  );
});

test("classifyUnitRow: a unit we already hold is left alone", async () => {
  const { classifyUnitRow } = await import(RULES_PATH);
  const live = { ids: new Set(["u-live"]), idByNumber: new Map([["1709 CW-1", "u-live"]]) };
  assert.deepEqual(classifyUnitRow({ resman_unit_id: "u-live", number: "1709 CW-1" }, live), {
    kind: "alreadyOurs",
  });
});

test("classifyUnitRow: a genuinely new unit is inserted with no collision", async () => {
  const { classifyUnitRow } = await import(RULES_PATH);
  const live = { ids: new Set(["u-live"]), idByNumber: new Map([["1709 CW-1", "u-live"]]) };
  assert.deepEqual(classifyUnitRow({ resman_unit_id: "u-new", number: "1815 BA-2" }, live), {
    kind: "insert",
  });
});

test("classifyUnitRow: a taken unit number under a different id is reported", async () => {
  const { classifyUnitRow } = await import(RULES_PATH);
  // The duplicate-inventory case: same physical unit, two ResMan records. It is
  // still an insert, but the caller must see it before applying.
  const live = { ids: new Set(["u-live"]), idByNumber: new Map([["1709 CW-1", "u-live"]]) };
  assert.deepEqual(classifyUnitRow({ resman_unit_id: "u-archived", number: "1709 CW-1" }, live), {
    kind: "insert",
    collision: { number: "1709 CW-1", archivedId: "u-archived", liveId: "u-live" },
  });
});

test("classifyUnitRow: a blank unit number cannot collide", async () => {
  const { classifyUnitRow } = await import(RULES_PATH);
  const live = { ids: new Set(["u-live"]), idByNumber: new Map([["", "u-live"]]) };
  assert.deepEqual(classifyUnitRow({ resman_unit_id: "u-archived", number: "  " }, live), {
    kind: "insert",
  });
});

test("units are off by default and the whole units pass is gated behind --with-units", () => {
  // Measured 2026-08-11: the three archived properties hold 891 units, exactly
  // the live count, and not one id overlaps — 882 collide by unit number. ResMan
  // minted new unit records at the merge, so importing the archived inventory
  // duplicates every address rather than adding anything.
  const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.match(stripped, /const withUnits = process\.argv\.includes\("--with-units"\)/);
  assert.match(stripped, /if \(withUnits\) \{/, "the units pass must be gated, not just its write");
  assert.match(
    stripped,
    /if \(apply && unitPass\.toInsert\.length > 0\)/,
    "and the write inside it still needs the apply gate",
  );
});

test("the resman_units write is unreachable without both flags", () => {
  const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const unitsWrite = stripped.indexOf('upsertMirror(supabase, "resman_units"');
  const gateOpen = stripped.indexOf("if (withUnits) {");
  assert.ok(unitsWrite > 0, "expected a resman_units upsert to exist");
  assert.ok(gateOpen > 0 && gateOpen < unitsWrite, "the units upsert must sit inside the flag gate");
});

test("the run holds the resman portal lock", () => {
  // A scheduled scrape must not overlap this one: the request ceiling is per
  // process, so two runners double it against the same portal.
  assert.match(SOURCE, /withLock\("resman", "run-merge-archived-properties", main\)/);
});

test("merging the write property into itself is refused", () => {
  assert.match(SOURCE, /archivedIds\.includes\(writePropertyId\)/);
});

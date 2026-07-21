const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUnitLookup, matchedUnit, resolveAccountUnit } = require("../src/mlgw/parse/unit-matching.ts");

function unit(over = {}) {
  return { unitId: "u-1", number: "3713 KG-3", street: "3713 Kingsgate Dr. Apt 3", city: "Memphis", state: "TN", ...over };
}

test("exact normalized street addresses still match (strict port path)", () => {
  const lookup = buildUnitLookup([unit()]);
  assert.equal(matchedUnit("3713 Kingsgate Dr Apt 3", lookup)?.unitId, "u-1");
});

test("loose: spaced-out street names match the squashed ResMan spelling", () => {
  const lookup = buildUnitLookup([unit()]);
  // MLGW bills the same building as "KINGS GATE".
  assert.equal(matchedUnit("3713 KINGS GATE DR APT 3", lookup)?.unitId, "u-1");
  assert.equal(matchedUnit("3713 KINGS GATE DR APT 4", lookup), null);
});

test("loose: directional prefix vs suffix and street-type drift both fold away", () => {
  const lookup = buildUnitLookup([
    unit({ unitId: "u-sng", number: "3591 SNG-2", street: "3591 New Gate Dr. South Apt 2" }),
    unit({ unitId: "u-mbr", number: "3608 MBR-4", street: "3608 Millbranch Dr. Apt 4" }),
  ]);
  assert.equal(matchedUnit("3591 S NEW GATE DR APT 2", lookup)?.unitId, "u-sng");
  assert.equal(matchedUnit("3608 MILL BRANCH RD APT 4", lookup)?.unitId, "u-mbr");
});

test("loose: a trailing extra street word on the MLGW side is dropped as a fallback", () => {
  const lookup = buildUnitLookup([
    unit({ unitId: "u-mbs", number: "1728 MBS-3", street: "1728 South Millbranch Dr. Apt 3" }),
  ]);
  assert.equal(matchedUnit("1728 S MILL BRANCH PARK DR APT 3", lookup)?.unitId, "u-mbs");
});

test("loose: ambiguous keys never match (unique-bucket discipline)", () => {
  const lookup = buildUnitLookup([
    unit({ unitId: "u-a", number: "3713 KG-3", street: "3713 Kings Gate Dr. Apt 3" }),
    unit({ unitId: "u-b", number: "3713 KG2-3", street: "3713 Kingsgate Dr. Apt 3" }),
  ]);
  // Both squash to loose:3713|kingsgate|3 — the bucket is ambiguous, so only
  // the strict per-unit address keys may match.
  assert.equal(matchedUnit("3713 KINGS GATE DR APT 3", lookup)?.unitId, "u-a");
  assert.equal(matchedUnit("3713 KINGSGATE DR APT 3", lookup)?.unitId, "u-b");
});

test("loose: no apt suffix on either side means no loose key at all", () => {
  const lookup = buildUnitLookup([unit({ unitId: "u-hold", number: "2x1.5 Holding Unit 4", street: "3619 Kingsgate Dr" })]);
  assert.equal(matchedUnit("3619 KINGS GATE DR", lookup), null);
});

test("resolveAccountUnit carries linkage columns and house detection", () => {
  const lookup = buildUnitLookup([unit()]);
  assert.deepEqual(resolveAccountUnit("3713 KINGS GATE DR APT 3", lookup), {
    resman_unit_id: "u-1",
    unit_number: "3713 KG-3",
    is_house_account: false,
  });
  assert.deepEqual(resolveAccountUnit("2441 KETCHUM RD APT 2", lookup), {
    resman_unit_id: "",
    unit_number: "",
    is_house_account: false,
  });
});


const assert = require("node:assert/strict");
const test = require("node:test");

const { titleCaseName, normalizeTenantNames, normalizePhoneNumber } = require("../src/resman/normalize");

// MARK: - titleCaseName (port of resManTitleCaseName)

test("titleCaseName title-cases ALL-CAPS names", () => {
  assert.equal(titleCaseName("FIRST NAME"), "First Name");
});

test("titleCaseName title-cases all-lowercase names", () => {
  assert.equal(titleCaseName("second resident"), "Second Resident");
});

test("titleCaseName judges each word, not the whole string", () => {
  // One already-cased word used to exempt the rest, so this stayed shouting.
  assert.equal(titleCaseName("REGINA COLLINS Jr"), "Regina Collins Jr");
  assert.equal(titleCaseName("Lakisha Williams hopson"), "Lakisha Williams Hopson");
});

test("titleCaseName keeps tokens that are correct in upper case", () => {
  assert.equal(titleCaseName("Roosevelt Moorehead III"), "Roosevelt Moorehead III", "not 'Iii'");
  assert.equal(titleCaseName("GMC"), "GMC", "not 'Gmc'");
  assert.equal(titleCaseName("BMW"), "BMW");
});

test("titleCaseName treats brackets as a word boundary", () => {
  // Without this the 'b' isn't a word start, and the annotation goes lowercase.
  assert.equal(titleCaseName("Dennis (BANKRUPTCY)"), "Dennis (Bankruptcy)");
});

test("titleCaseName tidies spacing around separators", () => {
  assert.equal(titleCaseName("Felicia Dilworth -Handy"), "Felicia Dilworth-Handy");
  assert.equal(titleCaseName("tan/ gold"), "Tan/Gold");
  assert.equal(titleCaseName("  double   spaced  "), "Double Spaced");
});

test("titleCaseName leaves already mixed-case names untouched", () => {
  assert.equal(titleCaseName("McBride Resident"), "McBride Resident");
  assert.equal(titleCaseName("O'Brien"), "O'Brien");
});

test("titleCaseName passes through empty / null / undefined", () => {
  assert.equal(titleCaseName(""), "");
  assert.equal(titleCaseName(null), null);
  assert.equal(titleCaseName(undefined), undefined);
});

// MARK: - normalizeTenantNames (lifted from ResManUnitSyncTests fixture)

test("normalizeTenantNames splits and normalizes the Residents column", () => {
  // Fixture from ResManUnitSyncTests.allUnitsCSVParserNormalizesTenantNames.
  const names = normalizeTenantNames("FIRST NAME, second resident, McBride Resident");
  assert.deepEqual(names, ["First Name", "Second Resident", "McBride Resident"]);
});

test("normalizeTenantNames drops empty segments and trims whitespace", () => {
  assert.deepEqual(normalizeTenantNames("  ALICE  ,, bob "), ["Alice", "Bob"]);
  assert.deepEqual(normalizeTenantNames(""), []);
});

// MARK: - normalizePhoneNumber

test("normalizePhoneNumber formats 10-digit numbers as (XXX) XXX-XXXX", () => {
  assert.equal(normalizePhoneNumber("9015551234"), "(901) 555-1234");
  assert.equal(normalizePhoneNumber("901.555.1234"), "(901) 555-1234");
  assert.equal(normalizePhoneNumber("+1 (901) 555-1234"), "(901) 555-1234");
});

test("normalizePhoneNumber passes through numbers that are not 10 significant digits", () => {
  assert.equal(normalizePhoneNumber("555-1234"), "555-1234");
  assert.equal(normalizePhoneNumber("ext 42"), "ext 42");
});

test("normalizeState resolves names, typos, noise, and junk", () => {
  const { normalizeState } = require("../src/resman/normalize.ts");
  // Already clean codes pass through (case-insensitively).
  assert.equal(normalizeState("TN"), "TN");
  assert.equal(normalizeState("ar"), "AR");
  // Full names and punctuation variants — real values from the register.
  assert.equal(normalizeState("Tennessee"), "TN");
  assert.equal(normalizeState("TENNESSEE"), "TN");
  assert.equal(normalizeState("T.N"), "TN");
  assert.equal(normalizeState("MISSISSIPPI"), "MS");
  assert.equal(normalizeState("KENTUCKY"), "KY");
  assert.equal(normalizeState("TEXAS"), "TX");
  // Truncations and trailing typos.
  assert.equal(normalizeState("ARK"), "AR");
  assert.equal(normalizeState("ARKANSASA"), "AR");
  // A code among noise.
  assert.equal(normalizeState("TN PINK"), "TN");
  // Ambiguous prefixes stay unresolved rather than guessed.
  assert.equal(normalizeState("MISS"), "");
  // Junk: plates in the state box, placeholders.
  assert.equal(normalizeState("BVH6926"), "");
  assert.equal(normalizeState("NA"), "");
  assert.equal(normalizeState("000000"), "");
  assert.equal(normalizeState("-"), "");
  assert.equal(normalizeState(""), "");
});

test("vehicleIdentityKey collapses per-unit duplicates", () => {
  const { vehicleIdentityKey } = require("../src/resman/normalize.ts");
  const car = { make: "Dodge", model: "Journey", year: "2015", color: "Gray", license_plate: "875BJZF" };
  // Same plate, same unit — same key, however the plate is formatted.
  assert.equal(
    vehicleIdentityKey("unit-1", car),
    vehicleIdentityKey("unit-1", { ...car, license_plate: " 875-bjzf " }),
  );
  // Same plate on a different unit is a different key.
  assert.notEqual(vehicleIdentityKey("unit-1", car), vehicleIdentityKey("unit-2", car));
  // No plate: identity falls back to the exact spec.
  const bare = { ...car, license_plate: "" };
  assert.equal(vehicleIdentityKey("u", bare), vehicleIdentityKey("u", { ...bare, make: "dodge " }));
  assert.notEqual(vehicleIdentityKey("u", bare), vehicleIdentityKey("u", { ...bare, color: "Red" }));
});

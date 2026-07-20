const { test } = require("node:test");
const assert = require("node:assert");
const { normalize, editDistance, tokenMatches, unitMatchesSearch } = require("../dist");

/** Minimal stand-in for a ResmanUnit — only the fields the matcher reads. */
function unit(fields = {}) {
  return {
    number: "1709 CW-1",
    street: "1709 Commonwealth Dr Apt 1",
    tenant_names: ["Jashunna Parker"],
    ...fields,
  };
}

test("normalize folds accents, punctuation and case", () => {
  assert.equal(normalize("José Muñoz"), "jose munoz");
  // Real spellings from the register — punctuation must not block a match.
  assert.equal(normalize("Leonard Mills*"), "leonard mills");
  assert.equal(normalize("Felicia Dilworth -Handy"), "felicia dilworth handy");
  assert.equal(normalize("Clarissa Turner (Bkrptcy)"), "clarissa turner bkrptcy");
  assert.equal(normalize("Geroy Rachel Sr."), "geroy rachel sr");
});

test("editDistance gives up once past the budget", () => {
  assert.equal(editDistance("smith", "smyth", 2), 1);
  assert.equal(editDistance("jashuna", "jashunna", 2), 1);
  assert.equal(editDistance("abc", "xyz", 1), 2, "returns max+1 rather than the true distance");
  assert.equal(editDistance("a", "aaaaaaaa", 2), 3, "length gap alone exceeds the budget");
});

test("exact and prefix matching still work", () => {
  assert.ok(unitMatchesSearch(unit(), "jashunna"));
  assert.ok(unitMatchesSearch(unit(), "jash"), "prefix");
  assert.ok(unitMatchesSearch(unit(), "parker"));
  assert.ok(unitMatchesSearch(unit(), "PARKER"), "case-insensitive");
});

test("tolerates misspellings of the kind the register actually contains", () => {
  assert.ok(unitMatchesSearch(unit(), "jashuna"), "one dropped letter");
  assert.ok(unitMatchesSearch(unit({ tenant_names: ["Tatyanna Smith"] }), "tatyana"));
  assert.ok(unitMatchesSearch(unit({ tenant_names: ["Haylie Neuenfeldt"] }), "neuenfelt"));
  assert.ok(unitMatchesSearch(unit({ tenant_names: ["Tatyanna Smith"] }), "smyth"));
});

test("punctuation in the stored name never blocks a match", () => {
  assert.ok(unitMatchesSearch(unit({ tenant_names: ["Leonard Mills*"] }), "mills"));
  assert.ok(unitMatchesSearch(unit({ tenant_names: ["Felicia Dilworth -Handy"] }), "dilworth handy"));
  assert.ok(unitMatchesSearch(unit({ tenant_names: ["Geroy Rachel Sr."] }), "rachel sr"));
});

test("is not so fuzzy that it matches the wrong tenant", () => {
  assert.ok(!unitMatchesSearch(unit(), "smith"), "a different surname entirely");
  assert.ok(!unitMatchesSearch(unit({ tenant_names: ["Ebony Baker"] }), "parker"), "baker is not parker");
  assert.ok(!unitMatchesSearch(unit({ tenant_names: ["Jill Flournoy"] }), "william"));
});

test("short words get no slack", () => {
  // With a budget, 3-letter queries would match half the register.
  assert.ok(!tokenMatches("ben", ["ken"]), "one edit apart but too short to fuzz");
  assert.ok(tokenMatches("ben", ["benjamin"]), "prefix still matches");
});

test("numbers never fuzz — a wrong digit is a wrong door", () => {
  assert.ok(unitMatchesSearch(unit(), "1709"));
  assert.ok(!unitMatchesSearch(unit(), "1809"), "one digit off must not match");
  assert.ok(!unitMatchesSearch(unit({ number: "1710 CW-2", street: "1710 Commonwealth Dr Apt 2" }), "1709"));
});

test("matches the full street address, not just the shorthand", () => {
  assert.ok(unitMatchesSearch(unit(), "commonwealth"));
  assert.ok(unitMatchesSearch(unit(), "commonwelth"), "misspelled street word still fuzzes");
  assert.ok(unitMatchesSearch(unit(), "cw"));
});

test("every typed word must land — search narrows, not widens", () => {
  assert.ok(unitMatchesSearch(unit(), "jashunna 1709"));
  assert.ok(!unitMatchesSearch(unit(), "jashunna 1809"), "second word fails, so no match");
});

test("empty query matches everything", () => {
  assert.ok(unitMatchesSearch(unit(), ""));
  assert.ok(unitMatchesSearch(unit(), "   "));
});

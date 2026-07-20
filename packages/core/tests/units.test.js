const assert = require("node:assert/strict");
const test = require("node:test");

const { formatUnitDisplay, normalizeUnitLabel } = require("../dist");

test("normalizeUnitLabel strips leading unit prefixes", () => {
  assert.equal(normalizeUnitLabel("Unit 3644 DU-1"), "3644 DU-1");
  assert.equal(normalizeUnitLabel("unit 1726 ST-4"), "1726 ST-4");
  assert.equal(normalizeUnitLabel("Apt 12"), "12");
  assert.equal(normalizeUnitLabel("apartment 12"), "12");
  assert.equal(normalizeUnitLabel("# 12"), "12");
  assert.equal(normalizeUnitLabel("3644 DU-1"), "3644 DU-1");
});

test("normalizeUnitLabel collapses whitespace and handles empty values", () => {
  assert.equal(normalizeUnitLabel("  Unit   3644   DU-1  "), "3644 DU-1");
  assert.equal(normalizeUnitLabel(""), "");
  assert.equal(normalizeUnitLabel("   "), "");
  assert.equal(normalizeUnitLabel(null), "");
  assert.equal(normalizeUnitLabel(undefined), "");
});

test("formatUnitDisplay falls back to an em dash for missing values", () => {
  assert.equal(formatUnitDisplay("Unit 3644 DU-1"), "3644 DU-1");
  assert.equal(formatUnitDisplay(null), "—");
  assert.equal(formatUnitDisplay(undefined), "—");
  assert.equal(formatUnitDisplay("   "), "—");
});

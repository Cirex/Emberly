
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseCsvRows,
  decodeCsvString,
  decodeCsvRows,
  CsvHeaderLookup,
  parseBool,
  parseDouble,
  parseInt10,
  parseCsvDate,
  normalizeCsvDate,
} = require("../src/resman/csv");

// MARK: - parseCsvRows edge cases (port of ResManCSVSupport.parseRows semantics)

test("parses a simple header + row", () => {
  assert.deepEqual(parseCsvRows("a,b,c\n1,2,3"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("handles quoted fields with embedded commas", () => {
  assert.deepEqual(parseCsvRows('name,note\n"Doe, Jane","hello, world"'), [
    ["name", "note"],
    ["Doe, Jane", "hello, world"],
  ]);
});

test("handles quoted fields with embedded newlines", () => {
  assert.deepEqual(parseCsvRows('a,b\n"line1\nline2",x'), [
    ["a", "b"],
    ["line1\nline2", "x"],
  ]);
});

test('unescapes doubled quotes ("") inside a quoted field', () => {
  assert.deepEqual(parseCsvRows('q\n"she said ""hi"""'), [["q"], ['she said "hi"']]);
});

test("treats CRLF, CR, and LF each as a row terminator", () => {
  assert.deepEqual(parseCsvRows("a,b\r\n1,2\r3,4\n5,6"), [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
    ["5", "6"],
  ]);
});

test("drops rows that are entirely empty", () => {
  assert.deepEqual(parseCsvRows("a,b\n\n1,2\n\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("flushes the final field/row at EOF with no trailing newline", () => {
  assert.deepEqual(parseCsvRows("x,y,z"), [["x", "y", "z"]]);
});

// MARK: - decode + BOM (port of decodeCSVString)

test("decodeCsvString strips a leading UTF-8 BOM", () => {
  const withBom = new TextEncoder().encode("﻿a,b\n1,2");
  assert.equal(decodeCsvString(withBom), "a,b\n1,2");
});

test("decodeCsvRows decodes bytes and parses in one step", () => {
  const bytes = new TextEncoder().encode("UnitID,Unit\nunit-1,101");
  const { rows } = decodeCsvRows(bytes);
  assert.deepEqual(rows, [
    ["UnitID", "Unit"],
    ["unit-1", "101"],
  ]);
});

test("decodeCsvString falls back for non-UTF-8 (Windows-1252) bytes", () => {
  // 0x92 is a Windows-1252 right single quote; invalid as standalone UTF-8.
  const bytes = new Uint8Array([0x4f, 0x92, 0x53]); // O ’ S
  const decoded = decodeCsvString(bytes);
  assert.ok(decoded.length >= 2);
  assert.ok(decoded.startsWith("O"));
});

// MARK: - CsvHeaderLookup (fixture: Unit Info report header row)

const UNIT_INFO_HEADER = [
  "BuildingID", "BuildingName", "PropertyID", "UnitID", "Number",
  "StreetAddress", "City", "State", "Zip", "SquareFootage",
  "PetsPermitted", "IsHoldingUnit", "AvailableForOnlineMarketing",
  "ExcludedFromOccupancy", "TotalMarketRent", "RequiredDeposit",
  "Status", "UnitTypeID", "UnitType", "UnitTypeBedrooms",
  "UnitTypeBathrooms", "UnitTypeMarketRent", "IsOccupied",
  "CurrentLeaseID", "CurrentLeaseStartDate", "CurrentLeaseEndDate",
  "CurrentResidentsMoveInDate", "PendingLeaseID", "PendingMoveInDate",
];

const UNIT_INFO_ROW = [
  "building-1", "Building 1", "property-1", "unit-info-1", "101",
  "123 Main St", "Memphis", "TN", "38103", "841",
  "True", "False", "True",
  "False", "1185.0000", "300.0000",
  "Ready", "floorplan-1", "2x1.5 Ruby", "2",
  "1.5", "1185.0000", "True",
  "lease-current", "7/1/2026 12:00:00 AM", "6/30/2027 12:00:00 AM",
  "7/1/2026 12:00:00 AM", "lease-pending", "8/1/2026 12:00:00 AM",
];

test("CsvHeaderLookup resolves columns case-insensitively and trims", () => {
  const lookup = new CsvHeaderLookup(UNIT_INFO_HEADER);
  assert.equal(lookup.value(UNIT_INFO_ROW, "UnitID"), "unit-info-1");
  assert.equal(lookup.value(UNIT_INFO_ROW, "  propertyid  "), "property-1");
  assert.equal(lookup.value(UNIT_INFO_ROW, "StreetAddress"), "123 Main St");
  assert.equal(lookup.has("UnitTypeBathrooms"), true);
  assert.equal(lookup.has("NoSuchColumn"), false);
});

test("CsvHeaderLookup.indexFirstOf picks the first present alias", () => {
  const lookup = new CsvHeaderLookup(["Category", "Description"]);
  // Work Order Summary has a known Category/Categoty typo fallback (design §3.3).
  assert.equal(lookup.indexFirstOf(["Categoty", "Category"]), 0);
  assert.equal(lookup.indexFirstOf(["Missing", "Description"]), 1);
  assert.equal(lookup.indexFirstOf(["Missing", "AlsoMissing"]), undefined);
});

test("CsvHeaderLookup.value returns empty string for out-of-range / missing", () => {
  const lookup = new CsvHeaderLookup(["A", "B", "C"]);
  assert.equal(lookup.value(["1"], "C"), "");
  assert.equal(lookup.value(["1", "2", "3"], "Z"), "");
});

// MARK: - scalar parsers

test("parseBool matches true/yes/1/y case-insensitively", () => {
  for (const truthy of ["true", "TRUE", "Yes", "1", "y", " true "]) {
    assert.equal(parseBool(truthy), true, truthy);
  }
  for (const falsy of ["false", "no", "0", "", "n", "maybe"]) {
    assert.equal(parseBool(falsy), false, falsy);
  }
});

test("parseDouble strips $ and thousands separators, tolerates blanks", () => {
  assert.equal(parseDouble("$1,185.00"), 1185);
  assert.equal(parseDouble("1185.0000"), 1185);
  assert.equal(parseDouble("  -1,250.50 "), -1250.5);
  assert.equal(parseDouble(""), null);
  assert.equal(parseDouble("n/a"), null);
});

test("parseInt10 strips separators and rejects non-integers", () => {
  assert.equal(parseInt10("1,234"), 1234);
  assert.equal(parseInt10("841"), 841);
  assert.equal(parseInt10(""), null);
  assert.equal(parseInt10("1.5"), null);
});

// MARK: - date parsing (fixtures use "M/d/yyyy h:mm:ss a")

test("parseCsvDate handles the ResMan datetime and ISO formats", () => {
  assert.notEqual(parseCsvDate("7/1/2026 12:00:00 AM"), null);
  assert.notEqual(parseCsvDate("07/01/2026"), null);
  assert.notEqual(parseCsvDate("2026-07-01"), null);
  assert.equal(parseCsvDate(""), null);
  assert.equal(parseCsvDate("not-a-date"), null);
});

test("parseCsvDate maps midnight AM/PM correctly", () => {
  const midnight = parseCsvDate("7/1/2026 12:00:00 AM");
  assert.equal(midnight.getHours(), 0);
  const noon = parseCsvDate("7/1/2026 12:00:00 PM");
  assert.equal(noon.getHours(), 12);
  const onePm = parseCsvDate("7/1/2026 1:30:00 PM");
  assert.equal(onePm.getHours(), 13);
});

test("normalizeCsvDate emits the schema's yyyy-MM-dd", () => {
  assert.equal(normalizeCsvDate("7/1/2026 12:00:00 AM"), "2026-07-01");
  assert.equal(normalizeCsvDate("12/31/2025"), "2025-12-31");
  assert.equal(normalizeCsvDate("garbage"), null);
});

test("parseCsvDate rejects impossible calendar dates", () => {
  assert.equal(parseCsvDate("2/30/2026"), null);
  assert.equal(parseCsvDate("13/1/2026"), null);
});

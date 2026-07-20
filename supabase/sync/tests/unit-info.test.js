const assert = require("node:assert/strict");
const test = require("node:test");

const { CsvHeaderLookup } = require("../src/resman/csv.ts");
const {
  buildUnitInfoForm,
  standardizedStreetAddress,
  mapUnitInfoRow,
} = require("../src/resman/reports/unit-info.ts");

test("buildUnitInfoForm is the base report form (no extra params)", () => {
  const fields = buildUnitInfoForm({ csrfToken: "tok", dxCss: "css" }, { propertyOrGroupId: "P1" });
  const names = fields.map(([n]) => n);
  assert.deepEqual(names.slice(0, 4), [
    "__RequestVerificationToken",
    "DisplayableReportName",
    "SetupRouteValues",
    "PropertyOrGroupParameter.PropertyOrGroupIDs",
  ]);
  assert.equal(fields.find(([n]) => n === "DisplayableReportName")[1], "Unit Info");
  assert.equal(names[names.length - 1], "Export");
});

test("standardizedStreetAddress normalizes the trailing unit marker", () => {
  assert.equal(standardizedStreetAddress("123 Main St #5"), "123 Main St Apt 5");
  assert.equal(standardizedStreetAddress("123 Main St Apt #5"), "123 Main St Apt 5");
  assert.equal(standardizedStreetAddress("  123   Main   St  "), "123 Main St");
  assert.equal(standardizedStreetAddress(""), "");
});

const HEADERS = [
  "UnitID", "Number", "PropertyID", "BuildingId", "BuildingName", "StreetAddress", "City",
  "State", "Zip", "Floor", "AvailableForOnlineMarketing", "HearingAccessible",
  "MobilityAccessible", "VisualAccessible", "RequiredDeposit", "PendingLeaseId",
  "PendingMoveInDate", "PendingLeaseStartDate", "PendingLeaseEndDate", "UnitTypeMaxOccupancy",
];
const lookup = new CsvHeaderLookup(HEADERS);
const ctx = { defaultPropertyId: "PDEF" };
const row = (v) => HEADERS.map((h) => v[h] ?? "");

test("mapUnitInfoRow enriches a unit and seeds its building", () => {
  const m = mapUnitInfoRow(
    lookup,
    row({
      UnitID: "u-1", Number: "101", PropertyID: "P1", BuildingId: "b-1", BuildingName: "Building A",
      StreetAddress: "123 Main St #5", City: "Memphis", State: "TN", Zip: "38103", Floor: "2",
      AvailableForOnlineMarketing: "true", HearingAccessible: "false", MobilityAccessible: "yes",
      VisualAccessible: "no", RequiredDeposit: "$500", PendingLeaseId: "PL9",
      PendingMoveInDate: "09/01/2026", PendingLeaseStartDate: "09/01/2026",
      PendingLeaseEndDate: "08/31/2027", UnitTypeMaxOccupancy: "4",
    }),
    ctx,
  );
  assert.ok(m);
  assert.equal(m.unit.resman_unit_id, "u-1");
  assert.equal(m.unit.resman_property_id, "P1");
  assert.equal(m.unit.resman_building_id, "b-1");
  assert.equal(m.unit.street, "123 Main St Apt 5");
  assert.equal(m.unit.city, "Memphis");
  assert.equal(m.unit.postal_code, "38103");
  assert.equal(m.unit.floor, "2");
  assert.equal(m.unit.available_for_online_marketing, true);
  assert.equal(m.unit.mobility_accessible, true);
  assert.equal(m.unit.visual_accessible, false);
  assert.equal(m.unit.deposit_required, 500);
  assert.equal(m.unit.pending_lease_id, "PL9");
  assert.equal(m.unit.pending_move_in_date, "2026-09-01");
  assert.equal(m.unit.pending_lease_end_date, "2027-08-31");
  assert.equal(m.unit.max_occupancy, 4);
  assert.deepEqual(m.building, { resman_building_id: "b-1", resman_property_id: "P1", name: "Building A" });
});

test("mapUnitInfoRow: property falls back to default, no building when BuildingId blank", () => {
  const m = mapUnitInfoRow(lookup, row({ UnitID: "u-2", Number: "102", PropertyID: "" }), ctx);
  assert.equal(m.unit.resman_property_id, "PDEF");
  assert.equal(m.unit.resman_building_id, null); // column present, value blank
  assert.equal(m.building, null);
});

test("mapUnitInfoRow skips blank, no-id, and excluded rows", () => {
  assert.equal(mapUnitInfoRow(lookup, row({}), ctx), null);
  assert.equal(mapUnitInfoRow(lookup, row({ UnitID: "", Number: "104" }), ctx), null);
  assert.equal(mapUnitInfoRow(lookup, row({ UnitID: "x", Number: "1x1 Lux" }), ctx), null);
});

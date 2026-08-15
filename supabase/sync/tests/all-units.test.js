
const assert = require("node:assert/strict");
const test = require("node:test");

const { CsvHeaderLookup } = require("../src/resman/csv.ts");
const {
  parseUnitTypeName,
  deriveOccupancy,
  formatAsOfDate,
  buildAllUnitsForm,
  mapAllUnitsRow,
} = require("../src/resman/reports/all-units.ts");

const HEADERS = [
  "UnitId", "Unit", "PropertyName", "PropertyID", "UnitTypeName", "LeaseStatus", "Vacant",
  "Residents", "MarketRent", "ActualRent", "DepositPaidIn", "MoveInDate", "MoveOutDate",
  "UnitStatus", "CurrentLeaseId", "PendingLeaseID", "LeaseStartDate", "LeaseEndDate",
  "Bedrooms", "Bathrooms", "Description", "IsHoldingUnit", "ExcludedFromOccupancy",
];
const lookup = new CsvHeaderLookup(HEADERS);
const ctx = { defaultPropertyId: "P1", sourceUrl: "https://x/Reports/AllUnits", scrapedAt: "2026-07-11T00:00:00.000Z" };

function row(values) {
  return HEADERS.map((h) => values[h] ?? "");
}

test("parseUnitTypeName splits layout + classification", () => {
  assert.deepEqual(parseUnitTypeName("2x2 Diamond"), { layout: "2x2", classification: "Diamond" });
  assert.deepEqual(parseUnitTypeName("1x1 lux"), { layout: "1x1", classification: "LUX" });
  assert.deepEqual(parseUnitTypeName("Studio"), { layout: "Studio", classification: "Legacy" });
  assert.deepEqual(parseUnitTypeName(""), { layout: "", classification: "Legacy" });
});

test("deriveOccupancy folds NTV + Eviction into Notice", () => {
  assert.equal(deriveOccupancy("Notice to Vacate", false), "Notice");
  assert.equal(deriveOccupancy("Under Eviction", false), "Notice");
  assert.equal(deriveOccupancy("Current", false), "Occupied");
  assert.equal(deriveOccupancy("Current", true), "Vacant");
});

test("formatAsOfDate uses M/d/yyyy h:mm:ss a", () => {
  const s = formatAsOfDate(new Date(2026, 6, 4, 14, 5, 9)); // Jul 4 2026 2:05:09 PM
  assert.equal(s, "7/4/2026 2:05:09 PM");
});

test("buildAllUnitsForm preserves order + checkbox convention", () => {
  const fields = buildAllUnitsForm({ csrfToken: "tok", dxCss: "css" }, { propertyOrGroupId: "P1", asOfDate: "7/4/2026 12:00:00 PM" });
  const names = fields.map(([n]) => n);
  assert.deepEqual(names.slice(0, 4), [
    "__RequestVerificationToken", "DisplayableReportName", "SetupRouteValues", "PropertyOrGroupParameter.PropertyOrGroupIDs",
  ]);
  // unchecked checkbox emits only "false"; tail is DXCss/ExportType/Export
  assert.deepEqual(fields.filter(([n]) => n === "AppendProjectLabelsParameter.Value").map(([, v]) => v), ["false"]);
  assert.equal(fields.find(([n]) => n === "ExportType")[1], "Source Data (CSV) w/ IDs");
  assert.equal(names[names.length - 1], "Export");
});

test("mapAllUnitsRow maps an occupied unit", () => {
  const u = mapAllUnitsRow(lookup, row({
    UnitId: "u-1", Unit: "101", PropertyID: "P1", UnitTypeName: "2x2 Diamond", LeaseStatus: "Current",
    Vacant: "false", Residents: "JOHN SMITH, jane doe", MarketRent: "$1,450", ActualRent: "1400",
    Bedrooms: "2", Bathrooms: "2", LeaseStartDate: "1/15/2026", CurrentLeaseId: "L9",
  }), ctx);
  assert.equal(u.resman_unit_id, "u-1");
  assert.equal(u.number, "101");
  assert.equal(u.classification, "Diamond");
  assert.equal(u.occupancy_status, "Occupied");
  assert.equal(u.occupied, true);
  assert.equal(u.lease_status, "Current");
  assert.deepEqual(u.tenant_names, ["John Smith", "Jane Doe"]);
  assert.equal(u.market_rent, 1450);
  assert.equal(u.bedrooms, 2);
  assert.equal(u.current_lease_id, "L9");
  assert.equal(u.lease_start_date, "2026-01-15");
});

/**
 * ResMan's All-Units export emits nine distinct LeaseStatus values. The mirror
 * allowed eight, and "Renewed" — the ninth — was silently written as null.
 *
 * Worth knowing what the column actually is, because two of its values lie:
 * of the 516 units with a current lease, 499 agree with it and 17 do not — 14
 * say "Cancelled" and 2 say "Pending Renewal" while the resident sits on a
 * live Current lease. ResMan is naming a superseded lease record there. So the
 * mirror stores what ResMan said, and anything that needs the truth reads
 * resman_leases.status instead.
 *
 * "Evicted" and "Former" are deliberately absent: ResMan never sends them at
 * unit level. When a tenancy genuinely ends the unit goes vacant and the field
 * is emptied (277 of 891 units, every one vacant).
 */
test("Renewed is a real ResMan value and must survive the allow-list", () => {
  const u = mapAllUnitsRow(lookup, row({ UnitId: "u-r", Unit: "3717 QU-1", LeaseStatus: "Renewed" }), ctx);
  assert.equal(u.lease_status, "Renewed");
});

test("mapAllUnitsRow derives Notice + coerces unknown lease_status to null", () => {
  const u = mapAllUnitsRow(lookup, row({
    UnitId: "u-2", Unit: "102", LeaseStatus: "Notice to Vacate", Vacant: "false",
  }), ctx);
  assert.equal(u.occupancy_status, "Notice");
  assert.equal(u.lease_status, "Notice to Vacate"); // in the allowed CHECK set

  const u2 = mapAllUnitsRow(lookup, row({ UnitId: "u-3", Unit: "103", LeaseStatus: "Weird", Vacant: "true" }), ctx);
  assert.equal(u2.lease_status, null);
  assert.equal(u2.occupancy_status, "Vacant");
});

test("mapAllUnitsRow skips blank, no-number, no-id, and excluded placeholder rows", () => {
  assert.equal(mapAllUnitsRow(lookup, row({}), ctx), null); // all blank
  assert.equal(mapAllUnitsRow(lookup, row({ UnitId: "x", Unit: "" }), ctx), null); // no number
  assert.equal(mapAllUnitsRow(lookup, row({ UnitId: "", Unit: "104" }), ctx), null); // no id
  assert.equal(mapAllUnitsRow(lookup, row({ UnitId: "x", Unit: "1x1 Lux" }), ctx), null); // excluded
});

test("mapAllUnitsRow stamps BOTH scraped_at and synced_at", () => {
  // Regression guard. `synced_at timestamptz default now()` only fires on
  // INSERT — an ON CONFLICT DO UPDATE never re-applies a column default — so
  // when the mapper emitted only `scraped_at`, resman_units.synced_at froze at
  // the moment the last brand-new unit appeared while the rows themselves
  // refreshed every run. The admin Units page reads max(synced_at) and
  // therefore reported a sync weeks stale on entirely current data.
  const u = mapAllUnitsRow(lookup, row({ UnitId: "u-9", Unit: "909", Vacant: "false" }), ctx);
  assert.equal(u.scraped_at, ctx.scrapedAt);
  assert.equal(u.synced_at, ctx.scrapedAt, "synced_at must be written, not left to the column default");
});

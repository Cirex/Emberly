const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAvailableUnitsForm,
  stripSpacesNormalizer,
  findUnitHeaderRowIndex,
  mapAvailableUnitsCsv,
} = require("../src/resman/reports/available-units.ts");

test("buildAvailableUnitsForm preserves order, sections, and checkbox convention", () => {
  const fields = buildAvailableUnitsForm(
    { csrfToken: "tok", dxCss: "css" },
    { propertyOrGroupId: "P1", asOfDate: "7/4/2026 12:00:00 PM" },
  );
  const names = fields.map(([n]) => n);
  assert.deepEqual(names.slice(0, 4), [
    "__RequestVerificationToken",
    "DisplayableReportName",
    "SetupRouteValues",
    "PropertyOrGroupParameter.PropertyOrGroupIDs",
  ]);
  // both checkboxes default true -> emit "true" then "false"
  assert.deepEqual(
    fields.filter(([n]) => n === "MergeParentsParameter.Value").map(([, v]) => v),
    ["true", "false"],
  );
  // all six report sections present
  const sections = fields.filter(([n]) => n === "ReportSectionsParameter.SelectedItems").map(([, v]) => v);
  assert.deepEqual(sections, [
    "Vacant",
    "Notice to Vacate",
    "Vacant Pre-Leased",
    "Notice to Vacate Pre-Leased",
    "Holding Units",
    "Under Eviction",
  ]);
  assert.equal(names[names.length - 1], "Export");
});

test("stripSpacesNormalizer collapses spaces + case", () => {
  assert.equal(stripSpacesNormalizer("Unit ID"), "unitid");
  assert.equal(stripSpacesNormalizer("UnitID"), "unitid");
  assert.equal(stripSpacesNormalizer("  Leasing Agent Last Name "), "leasingagentlastname");
});

const HEADERS = [
  "UnitID",
  "Unit",
  "PropertyID",
  "LeaseTerm",
  "MoveOutDate",
  "OldLeaseID",
  "UnitDateAvailable",
  "LeasingAgentLastName",
];

function rowsFixture() {
  const dataRow = (v) => HEADERS.map((h) => v[h] ?? "");
  return [
    ["Available Units — Realtime"], // preamble (no unit column)
    HEADERS.slice(), // header row (index 1)
    dataRow({ UnitID: "u-1", Unit: "101", PropertyID: "P1", LeaseTerm: "12", MoveOutDate: "07/15/2026", OldLeaseID: "L0", UnitDateAvailable: "08/01/2026", LeasingAgentLastName: "Nguyen" }),
    dataRow({ UnitID: "u-1", Unit: "101", PropertyID: "P1", LeaseTerm: "12", MoveOutDate: "07/15/2026", OldLeaseID: "L0", UnitDateAvailable: "08/01/2026", LeasingAgentLastName: "Nguyen" }), // exact duplicate
    HEADERS.slice(), // repeated header row
    dataRow({ UnitID: "u-2", Unit: "1x1 Lux" }), // excluded placeholder
    dataRow({ UnitID: "", Unit: "999" }), // no UnitId -> cannot target PK
    dataRow({ UnitID: "u-3", Unit: "103", PropertyID: "", UnitDateAvailable: "" }),
  ];
}

test("findUnitHeaderRowIndex locates the header past a preamble", () => {
  assert.equal(findUnitHeaderRowIndex(rowsFixture()), 1);
});

test("mapAvailableUnitsCsv enriches, dedupes, and skips excluded/no-id rows", () => {
  const r = mapAvailableUnitsCsv(rowsFixture(), { defaultPropertyId: "PDEF" });
  assert.equal(r.duplicates, 1);
  assert.equal(r.repeatedHeaders, 1);
  assert.equal(r.excluded, 1);
  assert.equal(r.skippedNoUnitId, 1);
  assert.equal(r.mapped.length, 2); // u-1 and u-3

  const u1 = r.mapped.find((m) => m.resman_unit_id === "u-1");
  assert.equal(u1.resman_property_id, "P1");
  assert.equal(u1.lease_term, "12");
  assert.equal(u1.move_out_date, "2026-07-15");
  assert.equal(u1.old_lease_id, "L0");
  assert.equal(u1.date_available, "2026-08-01");
  assert.equal(u1.leasing_agent, "Nguyen");

  const u3 = r.mapped.find((m) => m.resman_unit_id === "u-3");
  assert.equal(u3.resman_property_id, "PDEF"); // falls back to default
  assert.equal(u3.date_available, null); // blank -> null
  assert.equal(u3.leasing_agent, null);

  // uniform key set across the batch (required for one PostgREST upsert)
  assert.deepEqual(Object.keys(u1).sort(), Object.keys(u3).sort());
});

test("mapAvailableUnitsCsv only emits columns the report carries", () => {
  const headers = ["UnitID", "PropertyID", "MoveOutDate"];
  const rows = [headers, ["u-9", "P1", "01/02/2026"]];
  const r = mapAvailableUnitsCsv(rows, { defaultPropertyId: "PDEF" });
  assert.equal(r.mapped.length, 1);
  assert.deepEqual(Object.keys(r.mapped[0]).sort(), ["move_out_date", "resman_property_id", "resman_unit_id"]);
  assert.ok(!("lease_term" in r.mapped[0]));
});

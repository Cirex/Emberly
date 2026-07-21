const assert = require("node:assert/strict");
const test = require("node:test");

const { CsvHeaderLookup } = require("../src/resman/csv.ts");
const {
  firstAccountingPeriod,
  formatWorkOrderDate,
  buildWorkOrdersForm,
  mapWorkOrderStatus,
  mapWorkOrderPriority,
  mapWorkOrderRow,
} = require("../src/resman/reports/work-orders.ts");

test("firstAccountingPeriod extracts the first GUID-valued option", () => {
  const html = `
    <select><option value="not-a-guid">skip</option>
    <option value="3f2504e0-4f89-41d3-9a0c-0305e82c3301"> July 2026 </option>
    <option value="4f2504e0-4f89-41d3-9a0c-0305e82c3302">June 2026</option></select>`;
  assert.deepEqual(firstAccountingPeriod(html), {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    label: "July 2026",
  });
  assert.deepEqual(firstAccountingPeriod("<p>no options</p>"), { id: "", label: "" });
});

test("formatWorkOrderDate is MM/dd/yyyy", () => {
  assert.equal(formatWorkOrderDate(new Date(2026, 6, 4)), "07/04/2026");
});

test("buildWorkOrdersForm carries date range, statuses, and checkboxes", () => {
  const fields = buildWorkOrdersForm(
    { csrfToken: "tok", dxCss: "css" },
    {
      propertyOrGroupId: "P1",
      startDate: "01/01/2024",
      endDate: "07/13/2026",
      accountingPeriodId: "gid",
      accountingPeriodLabel: "July 2026",
    },
  );
  const byName = (n) => fields.filter(([k]) => k === n).map(([, v]) => v);
  assert.deepEqual(byName("PeriodOrDateRangeParameter.DateType"), ["DateRange"]);
  assert.deepEqual(byName("FilterByParameter.Value"), ["Reported Date"]);
  assert.equal(byName("StatusesParameter.SelectedItems").length, 8);
  // checked checkbox emits "true" then "false"
  assert.deepEqual(byName("IncludeMakeReadyParameter.Value"), ["true", "false"]);
  assert.equal(fields[fields.length - 1][0], "Export");
});

test("status + priority mapping fold into the CHECK sets", () => {
  assert.equal(mapWorkOrderStatus("In Progress"), "In Progress");
  assert.equal(mapWorkOrderStatus("cancelled"), "Canceled");
  assert.equal(mapWorkOrderStatus("Submitted"), "Not Started"); // unmapped -> default
  assert.equal(mapWorkOrderStatus("On Hold"), "Not Started");
  assert.equal(mapWorkOrderPriority("Emergency"), "Emergency");
  assert.equal(mapWorkOrderPriority("Whatever"), "Normal");
  assert.equal(mapWorkOrderPriority(""), "Normal");
});

const HEADERS = [
  "WorkorderID", "Number", "ObjectName", "ObjectType", "Status", "Priority", "Category",
  "Description", "Notes", "CompletionNotes", "AssignedPerson", "DateReported",
  "ScheduledDate", "DateCompleted", "MakeReady",
];
const lookup = new CsvHeaderLookup(HEADERS);
const row = (v) => HEADERS.map((h) => v[h] ?? "");

test("mapWorkOrderRow maps a unit work order and links the unit id", () => {
  const ctx = { propertyId: "P1", unitIdByNumber: new Map([["101", "u-1"]]) };
  const wo = mapWorkOrderRow(
    lookup,
    row({
      WorkorderID: "wo-1", Number: "WO-1001", ObjectName: "101", ObjectType: "Unit",
      Status: "In Progress", Priority: "High", Category: "Plumbing", Description: "Leak",
      AssignedPerson: "Sam", DateReported: "07/01/2026", MakeReady: "false",
    }),
    ctx,
  );
  assert.equal(wo.resman_work_order_id, "wo-1");
  assert.equal(wo.resman_unit_id, "u-1");
  assert.equal(wo.unit_number, "101");
  assert.equal(wo.status, "In Progress");
  assert.equal(wo.priority, "High");
  assert.equal(wo.category, "Plumbing");
  assert.equal(wo.title, "Leak");
  assert.equal(wo.date_reported, "2026-07-01");
  assert.equal(wo.is_make_ready, false);
});

test("mapWorkOrderRow folds make-ready categories into is_make_ready when the flag is false", () => {
  const ctx = { propertyId: "P1", unitIdByNumber: new Map() };
  const mk = (Category) =>
    mapWorkOrderRow(
      lookup,
      row({ WorkorderID: "wo-mr", ObjectType: "Unit", Status: "Completed", Category, MakeReady: "false" }),
      ctx,
    );
  // ResMan's MakeReady report flag misses these categories in prod.
  for (const category of ["Make Ready Maintenance", "Make Ready Not Complete", "Turn Maintenance/Punch", "Inspection and make ready"]) {
    assert.equal(mk(category).is_make_ready, true, category);
  }
  // Ordinary categories stay untouched ("Key Return" has no standalone "turn").
  for (const category of ["Plumbing", "HVAC", "Key Return"]) {
    assert.equal(mk(category).is_make_ready, false, category);
  }
  // And an explicit true flag still wins regardless of category.
  const flagged = mapWorkOrderRow(
    lookup,
    row({ WorkorderID: "wo-mr2", ObjectType: "Unit", Status: "Open", Category: "Plumbing", MakeReady: "true" }),
    ctx,
  );
  assert.equal(flagged.is_make_ready, true);
});

test("mapWorkOrderRow: Categoty typo fallback, non-unit gets null unit id, blank id skipped", () => {
  const ctx = { propertyId: "P1", unitIdByNumber: new Map() };
  const typoHeaders = [...HEADERS, "Categoty"];
  const typoLookup = new CsvHeaderLookup(typoHeaders);
  const typoRow = typoHeaders.map((h) => (h === "WorkorderID" ? "wo-2" : h === "Categoty" ? "HVAC" : h === "ObjectType" ? "Common Area" : ""));
  const wo = mapWorkOrderRow(typoLookup, typoRow, ctx);
  assert.equal(wo.category, "HVAC"); // falls back to Categoty
  assert.equal(wo.resman_unit_id, null); // ObjectType != Unit

  assert.equal(mapWorkOrderRow(lookup, row({ WorkorderID: "" }), ctx), null);
});

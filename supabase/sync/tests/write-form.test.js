const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const {
  parseWorkOrderEditForm,
  serializeControls,
  controlWireValue,
  findControl,
  setControlValue,
  formatResManDate,
  formatResManDateTime,
  decodeEntities,
} = require("../src/resman/write/form");

/**
 * The two fixtures are REAL server-rendered edit forms, captured 2026-08-26
 * from live ResMan (WO 16305 unit-scoped, WO 16376 building-scoped, PII-free).
 * Every structural assertion here pins a fact the writer's safety depends on.
 */
const fixture = (name) =>
  readFileSync(path.join(__dirname, "fixtures", `work-order-edit-${name}.html`), "utf8");

const WO_16305 = "6f09851a-df4e-488f-a86b-de4a60bd4225";
const WO_16376 = "d1737525-2f29-4608-a9c6-7d579e23feb0";

// MARK: - Parsing the live fixtures

test("parse: finds every named control on the unit-scoped fixture", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  const names = controls.map((control) => control.name);
  // The tag scanner must survive a raw '>' inside an attribute value —
  // Description's data-val-regex message contains one, and a naive regex
  // parser silently DROPS the control (the bug that motivated the scanner).
  assert.ok(names.includes("Description"), "Description control was dropped");
  assert.ok(names.includes("ReportingNotes"));
  assert.ok(names.includes("CompletedNotes"));
  assert.ok(names.includes("Status"));
  assert.ok(names.includes("ObjectID"));
  // 51 named controls counting the ASP.NET checkbox pair as two.
  assert.equal(controls.length, 54);
});

test("parse: rejects a page whose action does not match the work order", () => {
  assert.throws(() => parseWorkOrderEditForm(fixture("16305"), WO_16376), /action mismatch/);
});

test("parse: rejects a page without the form", () => {
  assert.throws(
    () => parseWorkOrderEditForm("<html><body>login</body></html>", WO_16305),
    /not found/,
  );
});

test("parse: WorkOrderID hidden field carries the id", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  assert.equal(findControl(controls, "WorkOrderID").value, WO_16305);
  assert.equal(findControl(controls, "PropertyID").value, "489f05ba-6bd4-4888-9460-88923577a6eb");
});

test("parse: async combobox current value rides in data-selected-value", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  const objectId = findControl(controls, "ObjectID");
  assert.equal(objectId.options.length, 0);
  assert.equal(objectId.dataSelectedValue, "a478dccd-7823-463d-8df4-a2adacb573c1");
  assert.equal(controlWireValue(objectId), "a478dccd-7823-463d-8df4-a2adacb573c1");
  assert.equal(findControl(controls, "ObjectType").value, "Unit");
});

test("parse: building-scoped fixture — ObjectType Building, its own ObjectID", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16376"), WO_16376);
  assert.equal(findControl(controls, "ObjectType").value, "Building");
  assert.equal(
    controlWireValue(findControl(controls, "ObjectID")),
    "a5fbb3ac-4f40-4ba1-b2a7-ba405514ef4d",
  );
});

test("parse: Status options are server-rendered with the current one selected", () => {
  const notStarted = parseWorkOrderEditForm(fixture("16305"), WO_16305).controls;
  assert.equal(controlWireValue(findControl(notStarted, "Status")), "Not Started");
  const completed = parseWorkOrderEditForm(fixture("16376"), WO_16376).controls;
  assert.equal(controlWireValue(findControl(completed, "Status")), "Completed");
  // <option>Submitted</option> has no value attr — HTML submits the TEXT.
  const status = findControl(completed, "Status");
  assert.deepEqual(
    status.options.map((option) => option.submitValue),
    ["Submitted", "Not Started", "Scheduled", "In Progress", "Pending Approval", "Completed", "Cancelled", "Closed", "On Hold"],
  );
});

test("parse: Description is a locked hidden input on the make-ready fixture", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  const description = findControl(controls, "Description");
  assert.equal(description.type, "hidden");
  assert.equal(description.value, "Clean, Replace, Repair flooring");
  // …but an ordinary text input on the other.
  const editable = findControl(parseWorkOrderEditForm(fixture("16376"), WO_16376).controls, "Description");
  assert.equal(editable.type, "text");
  assert.equal(editable.value, "Research 4");
});

test("parse: WorkOrderCategoryID shape varies by work order (hidden vs select)", () => {
  const locked = findControl(parseWorkOrderEditForm(fixture("16305"), WO_16305).controls, "WorkOrderCategoryID");
  assert.equal(locked.kind, "input");
  assert.equal(controlWireValue(locked), "1d6c793e-087c-4e82-a492-c7cc11cf8cee");
  const open = findControl(parseWorkOrderEditForm(fixture("16376"), WO_16376).controls, "WorkOrderCategoryID");
  assert.equal(open.kind, "select");
  assert.equal(controlWireValue(open), "23d3f93c-0c39-4381-a4de-0dd96e637b3b");
});

// MARK: - Serialization (what the browser would submit)

test("serialize: the ASP.NET checkbox pair submits only the hidden false", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16376"), WO_16376);
  const pairs = serializeControls(controls);
  const retention = pairs.filter(([name]) => name === "AddRetentionEffortNote");
  assert.deepEqual(retention, [["AddRetentionEffortNote", "false"]]);
});

test("serialize: pair order is document order and cancellation fields ride empty", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16376"), WO_16376);
  const pairs = serializeControls(controls);
  const names = pairs.map(([name]) => name);
  assert.ok(names.indexOf("WorkOrderID") === 0);
  assert.ok(names.indexOf("Status") < names.indexOf("CancellationReasonPickListItemID"));
  const byName = Object.fromEntries(pairs);
  assert.equal(byName.CancellationReasonPickListItemID, "");
  assert.equal(byName.CancellationDate, "");
  assert.equal(byName.SaveAndNew, "False");
  assert.equal(byName._RequiredFields, ",ObjectID,");
  // The known wire spellings from the live capture.
  assert.equal(byName.ReportedDateTime, "8/26/2026 7:40:43 PM");
  assert.equal(byName.ReportedDateTime_Date, "08/26/2026");
  assert.equal(byName["ReportedDateTime.Time"], "");
  assert.equal(byName.CompletedDate, "8/26/2026 7:43:00 PM");
  assert.equal(byName.CompletedByPersonID, "b78d380f-63e9-43c0-aab8-f75b906cb27e");
});

test("serialize: multi-selects (Areas, Pets) submit NOTHING when unselected", () => {
  // Their option lists hold real values ("Bathroom 1", "Cat"); a single-select
  // first-option default here would inject a spurious area/pet into every write.
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  const areas = findControl(controls, "Areas");
  assert.equal(areas.multiple, true);
  const names = serializeControls(controls).map(([name]) => name);
  assert.ok(!names.includes("Areas"));
  assert.ok(!names.includes("Pets"));
});

test("serialize: data-selected-value beats an unselected server option list", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  // VendorID renders 471 options, none selected; the stored value (the null
  // guid, ResMan's own "no vendor") rides in data-selected-value.
  assert.equal(
    controlWireValue(findControl(controls, "VendorID")),
    "00000000-0000-0000-0000-000000000000",
  );
  // The .Time halves echo their server-side selection: a booked 9:30 AM visit
  // re-renders selected and is submitted; an unset one submits the empty option.
  const { controls: done } = parseWorkOrderEditForm(fixture("16376"), WO_16376);
  const bySelected = Object.fromEntries(serializeControls(controls));
  assert.equal(bySelected["ScheduledDate.Time"], "9:30 AM");
  assert.equal(Object.fromEntries(serializeControls(done))["ScheduledDate.Time"], "");
});

test("serialize: disabled controls and buttons are never submitted", () => {
  const html =
    '<form action="/WorkOrders/Edit/x" method="post" id="NewEditWorkOrderForm">' +
    '<input name="A" value="1" /><input name="B" value="2" disabled />' +
    '<button name="C" value="3">Save</button><input type="submit" name="D" value="4" />' +
    "</form>";
  const { controls } = parseWorkOrderEditForm(html, "x");
  assert.deepEqual(serializeControls(controls), [["A", "1"]]);
});

test("serialize: select with options but no selected submits the first option", () => {
  const html =
    '<form action="/WorkOrders/Edit/x" method="post" id="NewEditWorkOrderForm">' +
    '<select name="S"><option value="">-</option><option value="a">A</option></select>' +
    "</form>";
  const { controls } = parseWorkOrderEditForm(html, "x");
  assert.deepEqual(serializeControls(controls), [["S", ""]]);
});

// MARK: - Mutation

test("setControlValue: moving a select's selection requires a real option", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  const status = findControl(controls, "Status");
  setControlValue(status, "Completed");
  assert.equal(controlWireValue(status), "Completed");
  assert.throws(() => setControlValue(status, "Vaporized"), /no option/);
});

test("setControlValue: async combobox mutation lands in data-selected-value", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16305"), WO_16305);
  const assigned = findControl(controls, "AssignedToPersonID");
  setControlValue(assigned, "55e3d0ac-69e5-434b-b6fe-23fce4131ffb");
  assert.equal(controlWireValue(assigned), "55e3d0ac-69e5-434b-b6fe-23fce4131ffb");
});

test("mutating one control changes exactly one pair", () => {
  const { controls } = parseWorkOrderEditForm(fixture("16376"), WO_16376);
  const before = serializeControls(controls);
  setControlValue(findControl(controls, "CompletedNotes"), "Water heater relit");
  const after = serializeControls(controls);
  assert.equal(before.length, after.length);
  const changed = before.filter(([name, value], i) => after[i][1] !== value).map(([name]) => name);
  assert.deepEqual(changed, ["CompletedNotes"]);
});

// MARK: - Entities and dates

test("decodeEntities: the attribute spellings ResMan uses", () => {
  assert.equal(decodeEntities("The characters &#39;&lt;&#39; and &#39;>&#39;"), "The characters '<' and '>'");
  assert.equal(decodeEntities("a&amp;b &quot;c&quot;"), 'a&b "c"');
});

test("dates: the three ResMan spellings, in Memphis wall time", () => {
  // 2026-08-27T00:43:00Z is 7:43:00 PM on the 26th in America/Chicago (CDT).
  const instant = new Date("2026-08-27T00:43:00Z");
  assert.equal(formatResManDateTime(instant), "8/26/2026 7:43:00 PM");
  assert.equal(formatResManDate(instant), "08/26/2026");
  // Noon and midnight edges (12-hour clock never says 0).
  assert.equal(formatResManDateTime(new Date("2026-01-05T18:00:00Z")), "1/5/2026 12:00:00 PM");
  assert.equal(formatResManDateTime(new Date("2026-01-05T06:00:00Z")), "1/5/2026 12:00:00 AM");
});

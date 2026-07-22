const { test } = require("node:test");
const assert = require("node:assert");
const {
  WORK_ORDER_CLOSED_STATUSES,
  WORK_ORDER_OPEN_STATUSES,
  isCallbackSignal,
  isClosedWorkOrder,
  isMakeReadyCategory,
  isOpenWorkOrder,
  makeUnitIndex,
  parseAll,
  parseDate,
  parseWorkOrder,
  priorityRank,
  technicianDisplayName,
  workOrderAgeDays,
} = require("../dist");

// Promoted from apps/maintenance/lib/derived/{types,parse}.ts — these are the
// rules both the maintenance and manager apps now share.

let seq = 0;
/** Minimal raw mirror row with the same defaults each app's zod schema applies. */
function row(fields) {
  seq += 1;
  return {
    resman_work_order_id: `wo-${seq}`,
    number: String(seq),
    unit_number: "",
    status: "Open",
    priority: "Normal",
    category: "",
    title: "",
    notes: "",
    completion_notes: "",
    technician: "",
    date_reported: null,
    date_scheduled: null,
    date_completed: null,
    is_make_ready: false,
    tags: [],
    is_duplicate: false,
    callback_status: "none",
    callback_matched_work_order_id: "",
    ...fields,
  };
}

const wo = (fields) => parseWorkOrder(row(fields));

test("parseDate reads date-only strings as LOCAL midnight", () => {
  const local = new Date(2026, 6, 20).getTime();
  assert.equal(parseDate("2026-07-20"), local);
  // A full timestamp still goes through Date.parse unchanged.
  assert.equal(parseDate("2026-07-20T09:30:00"), new Date("2026-07-20T09:30:00").getTime());
  assert.equal(parseDate(null), null);
  assert.equal(parseDate(""), null);
  assert.equal(parseDate("not a date"), null);
});

test("isMakeReadyCategory folds the categories ResMan's flag misses", () => {
  assert.equal(isMakeReadyCategory("Make Ready Maintenance"), true);
  assert.equal(isMakeReadyCategory("Make-Ready Not Complete"), true);
  assert.equal(isMakeReadyCategory("Turn Maintenance/Punch"), true);
  assert.equal(isMakeReadyCategory("Inspection and make ready"), true);
  assert.equal(isMakeReadyCategory("Plumbing"), false);
  assert.equal(isMakeReadyCategory("Returning resident"), false); // no \bturn\b
  assert.equal(isMakeReadyCategory(null), false);
});

test("technicianDisplayName normalizes the crew names", () => {
  assert.equal(technicianDisplayName(""), "Unassigned");
  assert.equal(technicianDisplayName("   "), "Unassigned");
  assert.equal(technicianDisplayName("Grounds Keeper 2"), "Grounds Keepers");
  assert.equal(technicianDisplayName("General Maintenance A"), "General Maintenance");
  assert.equal(technicianDisplayName("Maintenance Tech"), "General Maintenance");
  assert.equal(technicianDisplayName("Dana Reyes"), "Dana Reyes");
});

test("parseWorkOrder precomputes dates, age, and the search key", () => {
  const parsed = wo({
    unit_number: "204",
    title: "Leak under sink",
    notes: "Kitchen",
    technician: "Dana Reyes",
    date_reported: "2026-06-01T09:00:00",
    date_completed: "2026-06-04T09:00:00",
  });
  assert.equal(parsed.reportedAt, new Date("2026-06-01T09:00:00").getTime());
  assert.equal(parsed.daysToComplete, 3);
  assert.equal(parsed.technicianDisplay, "Dana Reyes");
  assert.ok(parsed.searchKey.includes("leak under sink"));
  assert.ok(parsed.searchKey.includes("204"));
});

test("parseWorkOrder folds make-ready by flag OR category", () => {
  assert.equal(wo({ is_make_ready: true }).isMakeReady, true);
  assert.equal(wo({ category: "Make Ready Maintenance" }).isMakeReady, true);
  assert.equal(wo({ category: "Plumbing" }).isMakeReady, false);
});

test("parseWorkOrder derives tags only when the row has none", () => {
  assert.deepEqual(wo({ tags: ["Explicit"], title: "AC not cooling" }).tags, ["Explicit"]);
  assert.deepEqual(wo({ title: "AC not cooling" }).tags, ["HVAC"]);
});

test("parseAll fills callback/duplicate signals and honors explicit ones", () => {
  const first = row({
    unit_number: "301",
    title: "Toilet running",
    notes: "Constantly runs",
    status: "Completed",
    date_reported: "2026-06-01T09:00:00",
    date_completed: "2026-06-02T09:00:00",
  });
  const repeat = row({
    unit_number: "301",
    title: "Toilet running",
    notes: "Constantly runs again",
    status: "Open",
    date_reported: "2026-06-08T09:00:00",
  });
  const parsed = parseAll([first, repeat]);
  assert.equal(parsed.length, 2);
  // The engine ran: the follow-up on the same unit/problem is flagged.
  const followUp = parsed[1];
  assert.ok(["possible", "confirmed"].includes(followUp.callbackStatus));
  assert.equal(isCallbackSignal(followUp), true);

  // An explicitly-set signal is never overwritten by the engine.
  const explicit = parseAll([
    row({ unit_number: "9", title: "X", callback_status: "dismissed" }),
  ])[0];
  assert.equal(explicit.callbackStatus, "dismissed");
});

test("parseAll excludes make-ready turns from the signal engine", () => {
  const parsed = parseAll([
    row({ unit_number: "5", is_make_ready: true, title: "Punch", status: "Completed", date_reported: "2026-06-01T09:00:00", date_completed: "2026-06-02T09:00:00" }),
    row({ unit_number: "5", is_make_ready: true, title: "Punch", status: "Open", date_reported: "2026-06-08T09:00:00" }),
  ]);
  assert.deepEqual(parsed.map((p) => p.callbackStatus), ["none", "none"]);
  assert.deepEqual(parsed.map((p) => p.isDuplicate), [false, false]);
});

test("open/closed membership excludes make-ready turns from both boards", () => {
  for (const status of WORK_ORDER_OPEN_STATUSES) {
    assert.equal(isOpenWorkOrder(wo({ status })), true, status);
    assert.equal(isClosedWorkOrder(wo({ status })), false, status);
  }
  for (const status of WORK_ORDER_CLOSED_STATUSES) {
    assert.equal(isClosedWorkOrder(wo({ status })), true, status);
    assert.equal(isOpenWorkOrder(wo({ status })), false, status);
  }
  assert.equal(isOpenWorkOrder(wo({ status: "Open", is_make_ready: true })), false);
  assert.equal(isClosedWorkOrder(wo({ status: "Closed", category: "Turn Maintenance" })), false);
  assert.equal(isOpenWorkOrder(wo({ status: "Martian" })), false);
});

test("priorityRank bands Emergency first and unknown as Normal", () => {
  assert.ok(priorityRank("Emergency") < priorityRank("High"));
  assert.ok(priorityRank("High") < priorityRank("Normal"));
  assert.ok(priorityRank("Normal") < priorityRank("Low"));
  assert.equal(priorityRank("Whatever"), priorityRank("Normal"));
});

test("workOrderAgeDays counts calendar days since reported", () => {
  const now = new Date(2026, 6, 15, 12).getTime();
  assert.equal(workOrderAgeDays(wo({ date_reported: "2026-07-10" }), now), 5);
  assert.equal(workOrderAgeDays(wo({ date_reported: null }), now), 0);
  // A future report date never reads as negative age.
  assert.equal(workOrderAgeDays(wo({ date_reported: "2026-07-20" }), now), 0);
});

test("makeUnitIndex keys by unit number and parses the date columns", () => {
  const index = makeUnitIndex([
    { number: "101", availability: "Ready", classification: "Ruby", move_in_date: "2026-08-01" },
    { number: "", availability: "Ready" }, // skipped: no unit number
  ]);
  assert.equal(index.size, 1);
  const facts = index.get("101");
  assert.equal(facts.availability, "Ready");
  assert.equal(facts.classification, "Ruby");
  assert.equal(facts.moveInAt, new Date(2026, 7, 1).getTime());
  assert.equal(facts.leaseStartAt, null);
  assert.deepEqual(facts.tenantNames, []);
});

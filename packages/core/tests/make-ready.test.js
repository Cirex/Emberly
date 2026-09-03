const { test } = require("node:test");
const assert = require("node:assert");
const {
  MAKE_READY_STAGES,
  addDays,
  buildMakeReadyGroups,
  currentStageOf,
  earliestReportedDate,
  isFullyCompletedTurn,
  latestCompletedDate,
  moveInUrgency,
  parseWorkOrder,
  quickFilterCounts,
  quickFilterIncludes,
  stagesOf,
  unitIsReady,
  urgencyShowsBadge,
} = require("../dist");

// Ported from apps/maintenance/tests/derived-boards.test.ts — the same
// fixtures, now exercising the promoted engine directly.

// Wed 2026-07-15 noon, device-local — the engine's calendar math is local.
const NOW = new Date("2026-07-15T12:00:00").getTime();

let seq = 0;
function wo(fields) {
  seq += 1;
  return parseWorkOrder({
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
  });
}

function facts(unitNumber, overrides) {
  return {
    unitNumber,
    classification: "",
    occupancyStatus: "",
    leaseStatus: "",
    availability: "",
    building: "",
    moveInAt: null,
    leaseStartAt: null,
    moveOutAt: null,
    tenantNames: [],
    ...overrides,
  };
}

const unitIndexOf = (...list) => new Map(list.map((f) => [f.unitNumber, f]));

test("stagesOf matches the real-world turn titles", () => {
  assert.deepEqual(stagesOf("Trash Out"), ["trashOut"]);
  assert.deepEqual(stagesOf("Punch List"), ["punch"]);
  assert.deepEqual(stagesOf("Flooring Replacement"), ["flooring"]);
  assert.deepEqual(stagesOf("Final Unit Walk/Inspection"), ["finalInspection"]);
  assert.deepEqual(stagesOf("Touch Up Painting"), ["cleaning"]);
  assert.deepEqual(stagesOf("Cleaning"), ["cleaning"]);
  assert.deepEqual(stagesOf("Rekey"), ["rekey"]);
  // One title can claim more than one slot.
  assert.deepEqual(stagesOf("Final Inspection and Cleaning"), ["finalInspection", "cleaning"]);
  assert.deepEqual(stagesOf("Leaky faucet under sink"), []);
});

test("MAKE_READY_STAGES is the six-stage checklist in workflow order", () => {
  assert.deepEqual(
    [...MAKE_READY_STAGES],
    ["trashOut", "punch", "flooring", "finalInspection", "cleaning", "rekey"],
  );
});

test("moveInUrgency brackets by signed calendar days", () => {
  assert.equal(moveInUrgency(null, NOW), "missingDate");
  assert.equal(moveInUrgency(addDays(NOW, -1), NOW), "overdue");
  assert.equal(moveInUrgency(addDays(NOW, 0), NOW), "today");
  assert.equal(moveInUrgency(addDays(NOW, 1), NOW), "nextSevenDays");
  assert.equal(moveInUrgency(addDays(NOW, 7), NOW), "nextSevenDays");
  assert.equal(moveInUrgency(addDays(NOW, 8), NOW), "nextFourteenDays");
  assert.equal(moveInUrgency(addDays(NOW, 14), NOW), "nextFourteenDays");
  assert.equal(moveInUrgency(addDays(NOW, 15), NOW), "scheduled");
});

test("urgencyShowsBadge covers only the urgent-now brackets", () => {
  assert.equal(urgencyShowsBadge("overdue"), true);
  assert.equal(urgencyShowsBadge("today"), true);
  assert.equal(urgencyShowsBadge("nextSevenDays"), true);
  assert.equal(urgencyShowsBadge("missingDate"), false);
  assert.equal(urgencyShowsBadge("nextFourteenDays"), false);
  assert.equal(urgencyShowsBadge("scheduled"), false);
});

// ── Board groups ────────────────────────────────────────────────────────────

/** Unit C1: a fully completed six-stage turn. */
const turnC1 = [
  wo({
    unit_number: "C1",
    is_make_ready: true,
    title: "Trash Out",
    status: "Completed",
    date_reported: "2026-06-01T09:00:00",
    date_completed: "2026-06-10T09:00:00",
  }),
  wo({
    unit_number: "C1",
    is_make_ready: true,
    title: "Punch",
    status: "Completed",
    date_reported: "2026-06-02T09:00:00",
    date_completed: "2026-06-11T09:00:00",
  }),
  wo({
    unit_number: "C1",
    is_make_ready: true,
    title: "Flooring",
    status: "Completed",
    date_reported: "2026-06-03T09:00:00",
    date_completed: "2026-06-12T09:00:00",
  }),
  wo({
    unit_number: "C1",
    is_make_ready: true,
    title: "Final Unit Walk/Inspection",
    status: "Closed",
    date_reported: "2026-06-04T09:00:00",
    date_completed: "2026-06-15T09:00:00",
  }),
  wo({
    unit_number: "C1",
    is_make_ready: true,
    title: "Touch Up Painting",
    status: "Completed",
    date_reported: "2026-06-05T09:00:00",
    date_completed: "2026-06-13T09:00:00",
  }),
  wo({
    unit_number: "C1",
    is_make_ready: true,
    title: "Rekey",
    status: "Completed",
    date_reported: "2026-06-06T09:00:00",
    date_completed: "2026-06-14T09:00:00",
  }),
];

/** Unit A1: partial turn — completed punch, open cleaning. */
const punchA1 = wo({
  unit_number: "A1",
  is_make_ready: true,
  title: "Punch",
  status: "Completed",
  date_reported: "2026-06-20T09:00:00",
  date_completed: "2026-06-21T09:00:00",
});
const cleaningA1 = wo({
  unit_number: "A1",
  is_make_ready: true,
  title: "Cleaning",
  status: "Open",
  date_reported: "2026-07-01T09:00:00",
});

/** Unit B1: single open stage, no unit facts. */
const trashB1 = wo({
  unit_number: "B1",
  is_make_ready: true,
  title: "Trash Out",
  status: "Open",
  date_reported: "2026-07-02T09:00:00",
});

/** Unit D1: candidate-preference cases. */
const punchDone = wo({
  unit_number: "D1",
  is_make_ready: true,
  title: "Punch",
  status: "Completed",
  date_reported: "2026-06-01T08:00:00",
  date_completed: "2026-06-02T08:00:00",
});
const punchOpenNewer = wo({
  unit_number: "D1",
  is_make_ready: true,
  title: "Punch",
  status: "Open",
  date_reported: "2026-07-01T08:00:00",
});
const rekeyEarly = wo({
  unit_number: "D1",
  is_make_ready: true,
  title: "Rekey",
  status: "Completed",
  date_reported: "2026-06-04T08:00:00",
  date_completed: "2026-06-05T08:00:00",
});
const rekeyLate = wo({
  unit_number: "D1",
  is_make_ready: true,
  title: "Rekey",
  status: "Completed",
  date_reported: "2026-06-03T08:00:00",
  date_completed: "2026-06-09T08:00:00",
});
const floorEarly = wo({
  unit_number: "D1",
  is_make_ready: true,
  title: "Flooring",
  status: "Open",
  date_reported: "2026-06-03T08:00:00",
});
const floorLate = wo({
  unit_number: "D1",
  is_make_ready: true,
  title: "Flooring",
  status: "Open",
  date_reported: "2026-06-08T08:00:00",
});

/** A regular ticket that must never claim a stage slot. */
const strayRegular = wo({
  unit_number: "A1",
  is_make_ready: false,
  title: "Punch",
  status: "Open",
  date_reported: "2026-07-10T09:00:00",
});

const groups = buildMakeReadyGroups({
  workOrders: [
    ...turnC1,
    punchA1,
    cleaningA1,
    trashB1,
    punchDone,
    punchOpenNewer,
    rekeyEarly,
    rekeyLate,
    floorEarly,
    floorLate,
    strayRegular,
  ],
  unitIndex: unitIndexOf(
    facts("A1", { moveInAt: addDays(NOW, 3), availability: "Not Ready" }),
    facts("C1", { moveInAt: addDays(NOW, 2), availability: "Ready", classification: "Ruby" }),
  ),
  nowMs: NOW,
});

function groupBy(unit) {
  const g = groups.find((x) => x.unitNumber === unit);
  assert.ok(g, `missing group ${unit}`);
  return g;
}

test("buildMakeReadyGroups orders dated groups by move-in asc, undated last", () => {
  assert.deepEqual(
    groups.map((g) => g.unitNumber),
    ["C1", "A1", "B1", "D1"],
  );
});

test("buildMakeReadyGroups joins unit facts with em-dash fallbacks", () => {
  assert.equal(groupBy("A1").unitStatus, "Not Ready");
  assert.equal(groupBy("C1").classification, "Ruby");
  assert.equal(groupBy("B1").unitStatus, "—");
  assert.equal(groupBy("B1").classification, "—");
  assert.equal(groupBy("B1").urgency, "missingDate");
  assert.equal(groupBy("C1").urgency, "nextSevenDays");
});

test("buildMakeReadyGroups assigns stages and counts completion", () => {
  const c1 = groupBy("C1");
  assert.equal(c1.completedStageCount, 6);
  assert.equal(c1.isComplete, true);
  assert.equal(currentStageOf(c1), null);

  const a1 = groupBy("A1");
  assert.equal(a1.stages.punch.id, punchA1.id);
  assert.equal(a1.stages.cleaning.id, cleaningA1.id);
  assert.equal(a1.stages.trashOut, null);
  assert.equal(a1.completedStageCount, 1);
  assert.equal(a1.isComplete, false);
  assert.equal(a1.latestDateMs, cleaningA1.reportedAt);
  // First slot not yet completed.
  assert.equal(currentStageOf(a1), "trashOut");
});

test("stage-slot preference: completed beats newer open, later date wins", () => {
  assert.equal(
    groupBy("D1").stages.punch.id,
    punchDone.id,
    "completed beats the newer open re-file",
  );
  assert.notEqual(groupBy("D1").stages.punch.id, punchOpenNewer.id);
  assert.equal(groupBy("D1").stages.rekey.id, rekeyLate.id, "later completedAt wins");
  assert.equal(groupBy("D1").stages.flooring.id, floorLate.id, "later reportedAt wins among open");
});

test("buildMakeReadyGroups defensively drops non-make-ready rows", () => {
  const ids = groupBy("A1").workOrders.map((w) => w.id);
  assert.equal(ids.includes(strayRegular.id), false);
  assert.equal(ids.length, 2);
});

test("quick filters: membership and counts", () => {
  const c1 = groupBy("C1");
  const a1 = groupBy("A1");
  const b1 = groupBy("B1");
  assert.equal(quickFilterIncludes("all", c1), true);
  // Complete turns are never "at risk", even inside the seven-day window…
  assert.equal(quickFilterIncludes("atRisk", c1), false);
  // …but "due this week" is urgency-only.
  assert.equal(quickFilterIncludes("dueThisWeek", c1), true);
  assert.equal(quickFilterIncludes("atRisk", a1), true);
  assert.equal(quickFilterIncludes("atRisk", b1), true); // missingDate counts
  assert.equal(quickFilterIncludes("dueThisWeek", b1), false);
  assert.equal(quickFilterIncludes("incomplete", c1), false);
  assert.equal(quickFilterIncludes("incomplete", a1), true);
  assert.equal(quickFilterIncludes("noMoveInDate", b1), true);
  assert.equal(quickFilterIncludes("noMoveInDate", a1), false);

  assert.deepEqual(quickFilterCounts(groups), {
    all: 4,
    atRisk: 3, // A1 + the two undated units; C1 is complete
    dueThisWeek: 2, // C1 + A1
    incomplete: 3,
    noMoveInDate: 2,
  });
});

test("unitIsReady exact-matches the ResMan availability text", () => {
  assert.equal(unitIsReady(groupBy("C1")), true);
  assert.equal(unitIsReady(groupBy("A1")), false); // "Not Ready"
  assert.equal(unitIsReady(groupBy("B1")), false); // no facts → "—"
  assert.deepEqual(
    groups.filter((g) => !unitIsReady(g)).map((g) => g.unitNumber),
    ["A1", "B1", "D1"],
  );
});

test("completed-turn helpers", () => {
  assert.equal(isFullyCompletedTurn(groupBy("C1")), true);
  assert.equal(isFullyCompletedTurn(groupBy("A1")), false);
  assert.equal(isFullyCompletedTurn(groupBy("D1")), false); // open flooring slot
  assert.equal(latestCompletedDate(groupBy("C1")), new Date("2026-06-15T09:00:00").getTime());
  assert.equal(latestCompletedDate(groupBy("A1")), null);
  assert.equal(earliestReportedDate(groupBy("C1")), new Date("2026-06-01T09:00:00").getTime());
});

// ── buildTurnThroughput ─────────────────────────────────────────────────────

const { buildTurnThroughput } = require("../dist");

/** A complete six-stage turn for `unit`, reported on `rep`, all stages
 *  completed on `done` (or left open when `done` is null). */
function turn(unit, rep, done) {
  const titles = [
    "Trash Out",
    "Punch",
    "Clean, Replace, Repair flooring",
    "Final Unit Walk/Inspection",
    "Touch up Painting",
    "Rekey and reassign Traka",
  ];
  return titles.map((title) =>
    wo({
      unit_number: unit,
      title,
      is_make_ready: true,
      date_reported: rep,
      status: done ? "Completed" : "Open",
      date_completed: done ?? null,
    }),
  );
}
const groupsOf = (...wos) =>
  buildMakeReadyGroups({ workOrders: wos.flat(), unitIndex: unitIndexOf(), nowMs: NOW });

test("buildTurnThroughput buckets a turn by its start and finish months", () => {
  const g = groupsOf(
    turn("A-1", "2026-05-04", "2026-05-20"), // started + finished in May
    turn("A-2", "2026-06-02", "2026-07-09"), // started Jun, finished Jul
    turn("A-3", "2026-07-01", null), // started Jul, still open
  );
  const t = buildTurnThroughput(g, NOW, 4); // Apr, May, Jun, Jul
  assert.equal(t.length, 4);
  const by = (m) => t[m];
  assert.deepEqual([by(0).started, by(0).finished], [0, 0], "April empty");
  assert.deepEqual([by(1).started, by(1).finished], [1, 1], "May 1 in 1 out");
  assert.deepEqual([by(2).started, by(2).finished], [1, 0], "June 1 in");
  assert.deepEqual([by(3).started, by(3).finished], [1, 1], "July 1 in 1 out");
});

test("openAtClose is exactly cumulative started minus cumulative finished", () => {
  const t = buildTurnThroughput(
    groupsOf(
      turn("B-1", "2026-05-04", "2026-05-20"),
      turn("B-2", "2026-06-02", "2026-07-09"),
      turn("B-3", "2026-07-01", null),
      turn("B-4", "2026-07-02", null),
    ),
    NOW,
    4,
  );
  let cs = 0,
    cf = 0;
  for (const m of t) {
    cs += m.started;
    cf += m.finished;
    assert.equal(m.openAtClose, cs - cf, `month ${new Date(m.monthMs).toISOString()}`);
  }
  assert.equal(t.at(-1).openAtClose, 2, "two turns still open at the end");
});

test("a turn started before the window still counts as open inside it", () => {
  // Started in January, still open — invisible to `started` but on the board.
  const t = buildTurnThroughput(groupsOf(turn("C-1", "2026-01-05", null)), NOW, 3);
  assert.equal(t[0].started, 0, "no arrival inside the window");
  assert.ok(
    t.every((m) => m.openAtClose === 1),
    "carried as an opening balance",
  );
});

test("a turn finished before the window is excluded entirely", () => {
  const t = buildTurnThroughput(groupsOf(turn("D-1", "2026-01-05", "2026-02-01")), NOW, 3);
  assert.ok(t.every((m) => m.started === 0 && m.finished === 0 && m.openAtClose === 0));
});

test("an incomplete turn never counts as finished, even with dated stages", () => {
  // ALL SIX stage slots filled and every one carrying a completion DATE, but
  // one still In Progress. latestCompletedDate therefore returns a real date —
  // only isFullyCompletedTurn rejects it. (An earlier version of this test
  // dropped the sixth stage entirely, which made latestCompletedDate return
  // null on its own and the assertion vacuous: removing the guard from the
  // implementation still passed.)
  const six = turn("E-1", "2026-06-01", "2026-06-15");
  const partial = six.map((w, i) =>
    i === 5
      ? wo({
          unit_number: "E-1",
          title: "Rekey and reassign Traka",
          is_make_ready: true,
          date_reported: "2026-06-01",
          status: "In Progress",
          date_completed: "2026-06-15",
        })
      : w,
  );
  const g = groupsOf(partial);
  assert.equal(isFullyCompletedTurn(g[0]), false, "guard sees it as unfinished");
  assert.notEqual(latestCompletedDate(g[0]), null, "but a finish DATE exists");
  const t = buildTurnThroughput(g, NOW, 3);
  assert.equal(
    t.reduce((n, m) => n + m.finished, 0),
    0,
    "never finishes",
  );
  assert.equal(t.at(-1).openAtClose, 1, "stays on the board");
});

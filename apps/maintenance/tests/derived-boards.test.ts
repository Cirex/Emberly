/**
 * Derived-board engine tests: tag icons, make-ready groups, hot-spot scoring.
 * All fixtures flow through parseWorkOrder (the real parse path) from minimal
 * raw rows, against a fixed local-time "now" so calendar math is deterministic.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { WorkOrderSchema, type WorkOrder } from "@/lib/api/work-orders";
import { parseWorkOrder } from "@/lib/derived/parse";
import type { ParsedWorkOrder, UnitFacts, UnitIndex } from "@/lib/derived/types";
import { addDays } from "@/lib/derived/time";
import { tagIconName } from "@/lib/derived/tags";
import {
  buildMakeReadyGroups,
  earliestReportedDate,
  isFullyCompletedTurn,
  latestCompletedDate,
  moveInUrgency,
  quickFilterCounts,
  quickFilterIncludes,
  stagesOf,
  unitIsReady,
  urgencyShowsBadge,
} from "@/lib/derived/make-ready";
import { buildHotSpotRows, hotSpotSparkline, hotSpotTopTrade, hotSpotWeeklyTrend } from "@/lib/derived/hot-spots";

// Wed 2026-07-15 noon, device-local — matches the engine's Calendar.current port.
const NOW = new Date("2026-07-15T12:00:00").getTime();

let seq = 0;
/** Minimal raw row → ParsedWorkOrder via the real schema defaults + parser. */
function wo(fields: Partial<WorkOrder> = {}): ParsedWorkOrder {
  seq += 1;
  return parseWorkOrder(WorkOrderSchema.parse({ resman_work_order_id: `wo-${seq}`, number: String(seq), ...fields }));
}

function facts(unitNumber: string, overrides: Partial<UnitFacts> = {}): UnitFacts {
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

function unitIndexOf(...list: UnitFacts[]): UnitIndex {
  return new Map(list.map((f) => [f.unitNumber, f]));
}

// ── Tag icons ───────────────────────────────────────────────────────────────

describe("tagIconName", () => {
  test("custom kinds take precedence over the substring table", () => {
    // "Broken Window" would fall to the fallback via the table; custom kind wins.
    expect(tagIconName("Broken Window")).toBe("glass-fragile");
    // "Water Heater" contains "water" (table → water drop); custom says boiler.
    expect(tagIconName("Water Heater")).toBe("water-boiler");
    expect(tagIconName("No Hot Water")).toBe("water-boiler");
  });

  test("custom word-set kinds require whole words", () => {
    expect(tagIconName("Clogged Drain")).toBe("pipe-disconnected");
    expect(tagIconName("Rodent Sighting")).toBe("rodent");
    expect(tagIconName("Mice")).toBe("rodent");
    expect(tagIconName("Loaned Equipment")).toBe("toolbox-outline");
  });

  test("custom substring kinds", () => {
    expect(tagIconName("Carpet Damage")).toBe("view-grid-outline");
    expect(tagIconName("Tile Repair")).toBe("view-grid-outline");
    expect(tagIconName("Mildew")).toBe("bacteria-outline");
    expect(tagIconName("Mailbox Key Broken")).toBe("mailbox-outline");
  });

  test("substring table, first match wins", () => {
    expect(tagIconName("Callback")).toBe("arrow-u-left-top");
    expect(tagIconName("Dupe")).toBe("content-duplicate");
    expect(tagIconName("Make Ready")).toBe("format-paint");
    expect(tagIconName("Urgent")).toBe("fire");
    expect(tagIconName("Plumbing Leak")).toBe("water-outline");
    expect(tagIconName("Electrical")).toBe("flash-outline");
    expect(tagIconName("Air Filter Replacement")).toBe("air-filter");
    expect(tagIconName("Engine Repair")).toBe("engine-outline");
    expect(tagIconName("HVAC")).toBe("air-conditioner");
    expect(tagIconName("Stove")).toBe("stove");
    expect(tagIconName("Dishwasher")).toBe("dishwasher");
    expect(tagIconName("Fridge")).toBe("fridge-outline");
    expect(tagIconName("Lockout")).toBe("key-variant");
    expect(tagIconName("Pest Control")).toBe("bug-outline");
    expect(tagIconName("Cleaning")).toBe("trash-can-outline");
    expect(tagIconName("Paint Touch Up")).toBe("brush");
  });

  test("active flag picks the filled variant where one exists", () => {
    expect(tagIconName("Plumbing Leak", true)).toBe("water");
    expect(tagIconName("Fridge", true)).toBe("fridge");
    expect(tagIconName("Loaned Equipment", true)).toBe("toolbox");
    // No filled variant → same glyph either way.
    expect(tagIconName("Dishwasher", true)).toBe("dishwasher");
  });

  test("fallback", () => {
    expect(tagIconName("Miscellaneous")).toBe("tag-outline");
    expect(tagIconName("Miscellaneous", true)).toBe("tag");
  });
});

// ── Make-ready stages ───────────────────────────────────────────────────────

describe("stagesOf", () => {
  test("keyword matching including the odd real-world titles", () => {
    expect(stagesOf("Trash Out")).toEqual(["trashOut"]);
    expect(stagesOf("Punch List")).toEqual(["punch"]);
    expect(stagesOf("Flooring Replacement")).toEqual(["flooring"]);
    expect(stagesOf("Final Unit Walk/Inspection")).toEqual(["finalInspection"]);
    expect(stagesOf("Touch Up Painting")).toEqual(["cleaning"]);
    expect(stagesOf("Cleaning")).toEqual(["cleaning"]);
    expect(stagesOf("Rekey")).toEqual(["rekey"]);
  });

  test("a title can claim multiple stages", () => {
    expect(stagesOf("Final Inspection and Cleaning")).toEqual(["finalInspection", "cleaning"]);
  });

  test("non-stage titles match nothing", () => {
    expect(stagesOf("Leaky faucet under sink")).toEqual([]);
  });
});

// ── Move-in urgency ─────────────────────────────────────────────────────────

describe("moveInUrgency", () => {
  test("brackets by signed calendar days", () => {
    expect(moveInUrgency(null, NOW)).toBe("missingDate");
    expect(moveInUrgency(addDays(NOW, -1), NOW)).toBe("overdue");
    expect(moveInUrgency(addDays(NOW, 0), NOW)).toBe("today");
    expect(moveInUrgency(addDays(NOW, 1), NOW)).toBe("nextSevenDays");
    expect(moveInUrgency(addDays(NOW, 7), NOW)).toBe("nextSevenDays");
    expect(moveInUrgency(addDays(NOW, 8), NOW)).toBe("nextFourteenDays");
    expect(moveInUrgency(addDays(NOW, 14), NOW)).toBe("nextFourteenDays");
    expect(moveInUrgency(addDays(NOW, 15), NOW)).toBe("scheduled");
  });

  test("badge only for the urgent-now brackets", () => {
    expect(urgencyShowsBadge("overdue")).toBe(true);
    expect(urgencyShowsBadge("today")).toBe(true);
    expect(urgencyShowsBadge("nextSevenDays")).toBe(true);
    expect(urgencyShowsBadge("missingDate")).toBe(false);
    expect(urgencyShowsBadge("nextFourteenDays")).toBe(false);
    expect(urgencyShowsBadge("scheduled")).toBe(false);
  });
});

// ── Make-ready groups ───────────────────────────────────────────────────────

/** Unit C1: a fully completed six-stage turn. */
const turnC1 = [
  wo({ unit_number: "C1", is_make_ready: true, title: "Trash Out", status: "Completed", date_reported: "2026-06-01T09:00:00", date_completed: "2026-06-10T09:00:00" }),
  wo({ unit_number: "C1", is_make_ready: true, title: "Punch", status: "Completed", date_reported: "2026-06-02T09:00:00", date_completed: "2026-06-11T09:00:00" }),
  wo({ unit_number: "C1", is_make_ready: true, title: "Flooring", status: "Completed", date_reported: "2026-06-03T09:00:00", date_completed: "2026-06-12T09:00:00" }),
  wo({ unit_number: "C1", is_make_ready: true, title: "Final Unit Walk/Inspection", status: "Closed", date_reported: "2026-06-04T09:00:00", date_completed: "2026-06-15T09:00:00" }),
  wo({ unit_number: "C1", is_make_ready: true, title: "Touch Up Painting", status: "Completed", date_reported: "2026-06-05T09:00:00", date_completed: "2026-06-13T09:00:00" }),
  wo({ unit_number: "C1", is_make_ready: true, title: "Rekey", status: "Completed", date_reported: "2026-06-06T09:00:00", date_completed: "2026-06-14T09:00:00" }),
];

/** Unit A1: partial turn — completed punch, open cleaning. */
const punchA1 = wo({ unit_number: "A1", is_make_ready: true, title: "Punch", status: "Completed", date_reported: "2026-06-20T09:00:00", date_completed: "2026-06-21T09:00:00" });
const cleaningA1 = wo({ unit_number: "A1", is_make_ready: true, title: "Cleaning", status: "Open", date_reported: "2026-07-01T09:00:00" });

/** Unit B1: single open stage, no unit facts. */
const trashB1 = wo({ unit_number: "B1", is_make_ready: true, title: "Trash Out", status: "Open", date_reported: "2026-07-02T09:00:00" });

/** Unit D1: candidate-preference cases. */
const punchDone = wo({ unit_number: "D1", is_make_ready: true, title: "Punch", status: "Completed", date_reported: "2026-06-01T08:00:00", date_completed: "2026-06-02T08:00:00" });
const punchOpenNewer = wo({ unit_number: "D1", is_make_ready: true, title: "Punch", status: "Open", date_reported: "2026-07-01T08:00:00" });
const rekeyEarly = wo({ unit_number: "D1", is_make_ready: true, title: "Rekey", status: "Completed", date_reported: "2026-06-04T08:00:00", date_completed: "2026-06-05T08:00:00" });
const rekeyLate = wo({ unit_number: "D1", is_make_ready: true, title: "Rekey", status: "Completed", date_reported: "2026-06-03T08:00:00", date_completed: "2026-06-09T08:00:00" });
const floorEarly = wo({ unit_number: "D1", is_make_ready: true, title: "Flooring", status: "Open", date_reported: "2026-06-03T08:00:00" });
const floorLate = wo({ unit_number: "D1", is_make_ready: true, title: "Flooring", status: "Open", date_reported: "2026-06-08T08:00:00" });

const strayRegular = wo({ unit_number: "A1", is_make_ready: false, title: "Punch", status: "Open", date_reported: "2026-07-10T09:00:00" });

const makeReadyIndex = unitIndexOf(
  facts("A1", { moveInAt: addDays(NOW, 3), availability: "Not Ready" }),
  facts("C1", { moveInAt: addDays(NOW, 2), availability: "Ready", classification: "Ruby" }),
);

const groups = buildMakeReadyGroups({
  workOrders: [...turnC1, punchA1, cleaningA1, trashB1, punchDone, punchOpenNewer, rekeyEarly, rekeyLate, floorEarly, floorLate, strayRegular],
  unitIndex: makeReadyIndex,
  nowMs: NOW,
});
const groupBy = (unit: string) => {
  const g = groups.find((x) => x.unitNumber === unit);
  if (!g) throw new Error(`missing group ${unit}`);
  return g;
};

describe("buildMakeReadyGroups", () => {
  test("orders dated groups by move-in asc, undated last by unit number", () => {
    expect(groups.map((g) => g.unitNumber)).toEqual(["C1", "A1", "B1", "D1"]);
  });

  test("joins unit facts with em-dash fallbacks", () => {
    expect(groupBy("A1").unitStatus).toBe("Not Ready");
    expect(groupBy("C1").classification).toBe("Ruby");
    expect(groupBy("B1").unitStatus).toBe("—");
    expect(groupBy("B1").classification).toBe("—");
    expect(groupBy("B1").urgency).toBe("missingDate");
    expect(groupBy("C1").urgency).toBe("nextSevenDays");
  });

  test("stage assignment and completion counting", () => {
    const c1 = groupBy("C1");
    expect(c1.completedStageCount).toBe(6);
    expect(c1.isComplete).toBe(true);

    const a1 = groupBy("A1");
    expect(a1.stages.punch?.id).toBe(punchA1.id);
    expect(a1.stages.cleaning?.id).toBe(cleaningA1.id);
    expect(a1.stages.trashOut).toBeNull();
    expect(a1.completedStageCount).toBe(1);
    expect(a1.isComplete).toBe(false);
    expect(a1.latestDateMs).toBe(cleaningA1.reportedAt as number);
  });

  test("completed candidate beats a newer non-completed one", () => {
    expect(groupBy("D1").stages.punch?.id).toBe(punchDone.id);
  });

  test("among completed candidates the later completedAt wins", () => {
    expect(groupBy("D1").stages.rekey?.id).toBe(rekeyLate.id);
  });

  test("among open candidates the later reportedAt wins", () => {
    expect(groupBy("D1").stages.flooring?.id).toBe(floorLate.id);
  });

  test("defensively drops non-make-ready rows", () => {
    expect(groupBy("A1").workOrders.map((w) => w.id)).not.toContain(strayRegular.id);
    expect(groupBy("A1").workOrders).toHaveLength(2);
  });
});

describe("make-ready quick filters", () => {
  test("membership per filter", () => {
    const [c1, a1, b1] = [groupBy("C1"), groupBy("A1"), groupBy("B1")];
    expect(quickFilterIncludes("all", c1)).toBe(true);
    // Complete turns are never "at risk", even inside the seven-day window…
    expect(quickFilterIncludes("atRisk", c1)).toBe(false);
    // …but "due this week" is urgency-only.
    expect(quickFilterIncludes("dueThisWeek", c1)).toBe(true);
    expect(quickFilterIncludes("atRisk", a1)).toBe(true);
    expect(quickFilterIncludes("atRisk", b1)).toBe(true); // missingDate counts
    expect(quickFilterIncludes("dueThisWeek", b1)).toBe(false);
    expect(quickFilterIncludes("incomplete", c1)).toBe(false);
    expect(quickFilterIncludes("incomplete", a1)).toBe(true);
    expect(quickFilterIncludes("noMoveInDate", b1)).toBe(true);
    expect(quickFilterIncludes("noMoveInDate", a1)).toBe(false);
  });

  test("counts", () => {
    expect(quickFilterCounts(groups)).toEqual({
      all: 4,
      atRisk: 3, // A1 + the two undated units; C1 is complete
      dueThisWeek: 2, // C1 + A1
      incomplete: 3,
      noMoveInDate: 2,
    });
  });
});

describe("unitIsReady (the schedule's stale-ticket guard)", () => {
  test("exact-matches the ResMan 'Ready' availability", () => {
    expect(unitIsReady(groupBy("C1"))).toBe(true);
    expect(unitIsReady(groupBy("A1"))).toBe(false); // "Not Ready"
    expect(unitIsReady(groupBy("B1"))).toBe(false); // no facts → "—"
  });

  test("filtering the schedule drops Ready units even with open tickets", () => {
    // C1's availability is "Ready" — whatever its tickets say, the schedule
    // must not show it. The others all survive.
    const schedule = groups.filter((g) => !unitIsReady(g));
    expect(schedule.map((g) => g.unitNumber)).toEqual(["A1", "B1", "D1"]);
  });
});

describe("completed-turn helpers", () => {
  test("fully completed turn requires all six slots completed", () => {
    expect(isFullyCompletedTurn(groupBy("C1"))).toBe(true);
    expect(isFullyCompletedTurn(groupBy("A1"))).toBe(false);
    expect(isFullyCompletedTurn(groupBy("D1"))).toBe(false); // open flooring slot
  });

  test("latestCompletedDate is the max across stages, null when any missing", () => {
    expect(latestCompletedDate(groupBy("C1"))).toBe(new Date("2026-06-15T09:00:00").getTime());
    expect(latestCompletedDate(groupBy("A1"))).toBeNull();
  });

  test("earliestReportedDate spans the whole group", () => {
    expect(earliestReportedDate(groupBy("C1"))).toBe(new Date("2026-06-01T09:00:00").getTime());
  });
});

// ── Hot spots ───────────────────────────────────────────────────────────────

describe("buildHotSpotRows", () => {
  // Unit 101 (vacant, moved out Jun 1): score 2+6+4+5 = 17 → Watch.
  const w1 = wo({ unit_number: "101", title: "Leak under sink", status: "Open", date_reported: "2026-06-25T09:00:00" }); // 20 open days → age +5
  const w2 = wo({ unit_number: "101", title: "Outlet dead", status: "Completed", date_reported: "2026-07-01T09:00:00", date_completed: "2026-07-03T09:00:00" });
  const w3 = wo({ unit_number: "101", title: "AC noise", status: "Closed", date_reported: "2026-07-10T09:00:00" });
  const mrText101 = wo({ unit_number: "101", title: "Paint", status: "Open", notes: "Prep for make ready.", date_reported: "2026-07-11T09:00:00" });
  const mrFlag101 = wo({ unit_number: "101", is_make_ready: true, title: "Cleaning", status: "Open", date_reported: "2026-07-12T09:00:00" });

  // Unit 201 (vacant, no move-out): score 2+6+8+2 = 18 → High on the score boundary.
  const o1 = wo({ unit_number: "201", title: "Toilet running", status: "Open", date_reported: "2026-07-05T09:00:00" }); // 10 open days → age +2
  const o2 = wo({ unit_number: "201", title: "Door sticking", status: "In Progress", date_reported: "2026-07-12T09:00:00" });
  const c1 = wo({ unit_number: "201", title: "Bulb out", status: "Completed", date_reported: "2026-07-01T09:00:00", date_completed: "2026-07-02T09:00:00" });

  // Unit 301 (no facts): score 2+4+4 = 10 → Watch on the inclusion boundary.
  const x1 = wo({ unit_number: "301", title: "Disposal jammed", status: "Open", date_reported: "2026-07-14T09:00:00" });
  const x2 = wo({ unit_number: "301", title: "Old repair", status: "Completed", date_reported: "2026-01-10T09:00:00", date_completed: "2026-01-12T09:00:00" });
  const x3 = wo({ unit_number: "301", title: "Filter change", status: "Closed", date_reported: "2026-07-01T09:00:00" });

  // Unit 401: three recent closed orders → score 8, below the floor → excluded.
  const y1 = wo({ unit_number: "401", title: "A", status: "Completed", date_reported: "2026-07-01T09:00:00" });
  const y2 = wo({ unit_number: "401", title: "B", status: "Completed", date_reported: "2026-07-02T09:00:00" });
  const y3 = wo({ unit_number: "401", title: "C", status: "Closed", date_reported: "2026-07-03T09:00:00" });

  // Units 501/502 (occupied since yesterday, so orders sit ON the boundary):
  // score 1+4+4+6 = 15, callback+open → High override.
  const s1 = wo({ unit_number: "501", title: "Leak returned", status: "Open", callback_status: "possible", date_reported: "2026-07-14T09:00:00" });
  const s2 = wo({ unit_number: "501", title: "Leak fixed", status: "Completed", date_reported: "2026-07-14T10:00:00", date_completed: "2026-07-15T09:00:00" });
  const t1 = wo({ unit_number: "502", title: "Leak returned", status: "Open", callback_status: "confirmed", date_reported: "2026-07-14T09:00:00" });
  const t2 = wo({ unit_number: "502", title: "Leak fixed", status: "Completed", date_reported: "2026-07-14T10:00:00", date_completed: "2026-07-15T09:00:00" });

  // Unit 601 (lease started Jun 1): pre-lease order excluded; score 0+2+4+6+3 = 15 → High.
  const preLease = wo({ unit_number: "601", title: "Previous tenant issue", status: "Completed", date_reported: "2026-05-20T09:00:00" });
  const z1 = wo({ unit_number: "601", title: "Smoke detector", status: "Open", callback_status: "confirmed", is_duplicate: true, date_reported: "2026-07-10T09:00:00" });

  // Unit 701: only order screams make-ready in the notes → no row at all.
  const mr701 = wo({ unit_number: "701", title: "Full unit prep", status: "Open", notes: "make ready", date_reported: "2026-07-10T09:00:00" });

  const rows = buildHotSpotRows({
    workOrders: [w1, w2, w3, mrText101, mrFlag101, o1, o2, c1, x1, x2, x3, y1, y2, y3, s1, s2, t1, t2, preLease, z1, mr701],
    unitIndex: unitIndexOf(
      facts("101", { occupancyStatus: "Vacant", moveOutAt: new Date("2026-06-01T00:00:00").getTime() }),
      facts("201", { occupancyStatus: "Vacant", classification: "Diamond" }),
      facts("401", { occupancyStatus: "Occupied" }),
      facts("501", { occupancyStatus: "Occupied", leaseStartAt: new Date("2026-07-14T00:00:00").getTime() }),
      facts("502", { occupancyStatus: "Occupied", leaseStartAt: new Date("2026-07-14T00:00:00").getTime() }),
      facts("601", { occupancyStatus: "Occupied", leaseStartAt: new Date("2026-06-01T00:00:00").getTime() }),
    ),
    nowMs: NOW,
  });
  const rowBy = (unit: string) => {
    const r = rows.find((x) => x.unitNumber === unit);
    if (!r) throw new Error(`missing row ${unit}`);
    return r;
  };

  test("row sort: score desc, then unit number numeric on full ties", () => {
    expect(rows.map((r) => r.unitNumber)).toEqual(["201", "101", "501", "502", "601", "301"]);
  });

  test("hand-computed score with open-age weight (unit 101)", () => {
    const r = rowBy("101");
    expect(r.totalCount).toBe(3);
    expect(r.recentCount).toBe(3);
    expect(r.openCount).toBe(1);
    expect(r.callbackCount).toBe(0);
    expect(r.duplicateCount).toBe(0);
    expect(r.oldestOpenDays).toBe(20);
    expect(r.score).toBe(17); // 2 + 6 + 4 + 5
    expect(r.riskLevel).toBe("Watch"); // 17 < 18, no callback+open
  });

  test("score 18 boundary is High without any callback (unit 201)", () => {
    const r = rowBy("201");
    expect(r.score).toBe(18); // 2 + 6 + 8 + 2
    expect(r.riskLevel).toBe("High");
    expect(r.oldestOpenDays).toBe(10);
    expect(r.classification).toBe("Diamond");
  });

  test("score 10 boundary is included as Watch (unit 301)", () => {
    const r = rowBy("301");
    expect(r.score).toBe(10); // 2 + 4 + 4
    expect(r.riskLevel).toBe("Watch");
    expect(r.recentCount).toBe(2); // the January order aged out of detail
    expect(r.detail).toHaveLength(2);
  });

  test("below the floor is excluded even with 3 total orders (unit 401)", () => {
    expect(rows.map((r) => r.unitNumber)).not.toContain("401");
  });

  test("callback + open forces High below the score threshold (unit 501)", () => {
    const r = rowBy("501");
    expect(r.score).toBe(15); // 1 + 4 + 4 + 6
    expect(r.riskLevel).toBe("High");
    expect(r.callbackDetail.map((w) => w.id)).toEqual([s1.id]);
  });

  test("orders before the lease-start boundary are excluded (unit 601)", () => {
    const r = rowBy("601");
    expect(r.totalCount).toBe(1); // pre-lease order dropped
    expect(r.score).toBe(15); // 0 + 2 + 4 + 6 + 3(dup)
    expect(r.riskLevel).toBe("High");
    expect(r.duplicateCount).toBe(1);
    expect(r.duplicateDetail.map((w) => w.id)).toEqual([z1.id]);
  });

  test("make-ready text and flag exclusions (units 101, 701)", () => {
    // The flagged + " make ready "-noted orders never reached unit 101's counts…
    expect(rowBy("101").totalCount).toBe(3);
    // …and a unit with only make-ready-ish work has no row.
    expect(rows.map((r) => r.unitNumber)).not.toContain("701");
  });

  test("occupancy labels", () => {
    expect(rowBy("501").occupiedDaysText).toBe("1 day occupied"); // singular
    expect(rowBy("501").sinceLabel).toBe("Since Move In");
    expect(rowBy("101").occupiedDaysText).toBeNull();
    expect(rowBy("101").sinceLabel).toBe("Since Move Out");
    expect(rowBy("201").sinceLabel).toBe("Since Available"); // vacant, no move-out
  });

  test("detail sort: status rank first, then activity desc", () => {
    expect(rowBy("101").detail.map((w) => w.id)).toEqual([w1.id, w2.id, w3.id]); // Open, Completed, Closed
    expect(rowBy("201").detail.map((w) => w.id)).toEqual([o1.id, o2.id, c1.id]); // Open before In Progress despite older date
  });

  test("last activity tracks the max activity date", () => {
    expect(rowBy("101").lastActivityMs).toBe(w3.reportedAt as number);
  });
});

describe("hot-spot trend helpers", () => {
  const NOW = new Date("2026-07-15T12:00:00").getTime();
  const mk = (offsetsDays: number[], tags: string[][] = []) =>
    ({
      detail: offsetsDays.map((d, i) => ({
        reportedAt: NOW - d * 24 * 60 * 60 * 1000,
        tags: tags[i] ?? [],
      })),
    }) as never;

  test("sparkline buckets recent detail into weekly counts, oldest first", () => {
    const row = mk([1, 2, 9, 40]); // two this week, one last-ish week, one out of 6w? 40d < 42d so in bucket 0
    const spark = hotSpotSparkline(row, NOW, 6);
    expect(spark).toHaveLength(6);
    expect(spark[5]).toBe(2); // 1d + 2d ago land in the newest bucket
    expect(spark.reduce((a, b) => a + b, 0)).toBe(4);
  });

  test("weekly trend sums across rows and drops out-of-window tickets", () => {
    const rows = [mk([1]), mk([3, 100])] as never[];
    const trend = hotSpotWeeklyTrend(rows as never, NOW, 8);
    expect(trend).toHaveLength(8);
    expect(trend.reduce((a, b) => a + b, 0)).toBe(2); // the 100d ticket is outside 8 weeks
  });

  test("top trade requires a repeat and picks the most frequent tag", () => {
    const row = mk([1, 2, 3], [["HVAC"], ["HVAC"], ["Plumbing"]]);
    expect(hotSpotTopTrade(row)).toEqual({ tag: "HVAC", count: 2 });
    const single = mk([1], [["HVAC"]]);
    expect(hotSpotTopTrade(single)).toBeNull();
  });
});

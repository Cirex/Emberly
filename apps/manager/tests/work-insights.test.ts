import { describe, expect, test } from "bun:test";
import { WorkOrderSchema, type WorkOrder } from "@/lib/api/work-orders";
import { ResmanUnitSchema, type ResmanUnit } from "@/lib/api/units";
import { buildOpenUnitGroups, buildWorkData } from "@/lib/derived/work-boards";
import { buildWorkInsights } from "@/lib/derived/work-insights";

/** Tuesday, July 21 2026, noon. */
const NOW = new Date(2026, 6, 21, 12).getTime();

function wo(over: Partial<WorkOrder> & { resman_work_order_id: string }): WorkOrder {
  return WorkOrderSchema.parse(over);
}
function unit(over: Partial<ResmanUnit> & { resman_unit_id: string }): ResmanUnit {
  return ResmanUnitSchema.parse(over);
}

const UNITS: ResmanUnit[] = [unit({ resman_unit_id: "u-101", number: "0101" })];

const ORDERS: WorkOrder[] = [
  // Unit 0101: emergency, 10 days old, Marcus.
  wo({
    resman_work_order_id: "e1", number: "9001", unit_number: "0101",
    priority: "Emergency", status: "Open", category: "Plumbing",
    date_reported: "2026-07-11", technician: "Marcus",
  }),
  // Unit 0101: normal, 2 days old, Marcus (unit now has 2 open → a hot spot).
  wo({
    resman_work_order_id: "n2", number: "9002", unit_number: "0101",
    priority: "Normal", status: "In Progress", category: "Appliance",
    date_reported: "2026-07-19", technician: "Marcus",
  }),
  // Unit 0202: normal, today, Dre.
  wo({
    resman_work_order_id: "n1", number: "9003", unit_number: "0202",
    priority: "Normal", status: "Open", category: "Electrical",
    date_reported: "2026-07-21", technician: "Dre",
  }),
  // Unit 0101 closed 5 days ago, 3-day close, callback → adds to the hot spot.
  wo({
    resman_work_order_id: "c1", number: "9004", unit_number: "0101",
    priority: "Normal", status: "Completed", category: "HVAC",
    date_reported: "2026-07-13", date_completed: "2026-07-16",
    technician: "Marcus", callback_status: "confirmed",
  }),
  // Unit 0303 closed 40 days ago (prior-30 window), 5-day close, Dre.
  wo({
    resman_work_order_id: "c2", number: "9005", unit_number: "0303",
    priority: "Normal", status: "Completed", category: "Appliance",
    date_reported: "2026-06-06", date_completed: "2026-06-11", technician: "Dre",
  }),
];

const DATA = buildWorkData(ORDERS, UNITS);

describe("buildWorkInsights", () => {
  const ins = buildWorkInsights(DATA, NOW);

  test("scorecards: open / emergency / closed windows / median / per-tech", () => {
    expect(ins.openNow).toBe(3);
    expect(ins.emergencies).toBe(1);
    expect(ins.overdue).toBe(1); // only the 10-day-old emergency is past the 4-day target
    expect(ins.closed30).toBe(1);
    expect(ins.closedPrior30).toBe(1);
    expect(ins.medianCloseDays).toBe(4); // median of [3, 5]
    expect(ins.targetDays).toBe(4);
    expect(ins.callbackPairs).toBe(1);
    expect(ins.perTech).toBeCloseTo(1.5, 5); // 3 open / 2 active techs
  });

  test("category mix counts open + 90-day closed, most first", () => {
    // Appliance appears twice (one open, one closed-90d) → leads.
    expect(ins.categories[0]).toEqual({ label: "Appliance", count: 2 });
  });

  test("open-age buckets split 0-1 / 2-3 / 4-7 / 8+", () => {
    expect(ins.ageBuckets.map((b) => b.count)).toEqual([1, 1, 0, 1]);
  });

  test("technician workload ranks by open count, with per-tech close stats", () => {
    const marcus = ins.techWorkload.find((t) => t.tech === "Marcus");
    expect(marcus?.openCount).toBe(2);
    expect(marcus?.medianCloseDays).toBe(3);
    expect(marcus?.closed30).toBe(1);
    expect(ins.techWorkload[0].tech).toBe("Marcus"); // highest open count leads
  });

  test("hot spots surface repeat-order units, ranked", () => {
    expect(ins.hotSpots[0]).toEqual({ unitNumber: "0101", orders: 3, callbacks: 1, rank: 1 });
    // Units with a single order never qualify.
    expect(ins.hotSpots.every((h) => h.orders >= 2)).toBe(true);
  });

  test("12-week close cadence and signal weeks are fixed-length", () => {
    expect(ins.closesPerWeek).toHaveLength(12);
    expect(ins.signalsPerWeek).toHaveLength(7);
    // The 5-days-ago close lands in the most recent week bucket.
    expect(ins.closesPerWeek[11]).toBe(1);
  });
});

describe("buildOpenUnitGroups", () => {
  const groups = buildOpenUnitGroups(DATA, NOW);

  test("groups open orders by unit, emergency unit first", () => {
    expect(groups.map((g) => g.unitNumber)).toEqual(["0101", "0202"]);
  });

  test("carries open + lifetime counts and the timeline for units with history", () => {
    const g = groups[0];
    expect(g.openCount).toBe(2); // e1 + n2
    expect(g.totalCount).toBe(3); // + the closed c1
    expect(g.closedCount).toBe(1);
    expect(g.timeline).not.toBeNull();
    expect(g.timeline?.dots).toHaveLength(3);
    expect(g.lines[0].priority).toBe("Emergency"); // most urgent leads
  });

  test("a single-order unit gets no rail and the first-order note", () => {
    const g = groups[1];
    expect(g.openCount).toBe(1);
    expect(g.totalCount).toBe(1);
    expect(g.timeline).toBeNull();
    expect(g.closedCount).toBe(0);
  });

  test("units with no open orders are absent (0303 is closed-only)", () => {
    expect(groups.some((g) => g.unitNumber === "0303")).toBe(false);
  });
});

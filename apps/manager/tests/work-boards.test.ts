import { describe, expect, test } from "bun:test";
import { WorkOrderSchema, type WorkOrder } from "@/lib/api/work-orders";
import { ResmanUnitSchema, type ResmanUnit } from "@/lib/api/units";
import {
  buildClosedBoard,
  buildMakeReadyBoard,
  buildOpenBoard,
  buildWorkData,
  makeReadySnapshot,
} from "@/lib/derived/work-boards";

/**
 * The Work tab's derived boards over the shared @emberly/core engine. The
 * engine's own rules (parsing, stages, urgency) are covered in
 * packages/core/tests; these tests pin the manager-side banding, metrics, and
 * the Today-card snapshot.
 */

// Tuesday, July 21 2026, noon local. Week runs Mon Jul 20 – Sun Jul 26.
const NOW = new Date(2026, 6, 21, 12).getTime();

function wo(over: Partial<WorkOrder> & { resman_work_order_id: string }): WorkOrder {
  return WorkOrderSchema.parse(over);
}

function unit(over: Partial<ResmanUnit> & { resman_unit_id: string }): ResmanUnit {
  return ResmanUnitSchema.parse(over);
}

const UNITS: ResmanUnit[] = [
  // Move-in tomorrow (urgent, next seven days), turn still going.
  unit({ resman_unit_id: "u-644", number: "0644", availability: "Not Ready", move_in_date: "2026-07-22" }),
  // Move-in yesterday (overdue) — the "late for move-in" case.
  unit({ resman_unit_id: "u-700", number: "0700", availability: "Not Ready", move_in_date: "2026-07-20" }),
  // ResMan already flipped this one to Ready; no move-in date on file.
  unit({ resman_unit_id: "u-800", number: "0800", availability: "Ready" }),
];

const ORDERS: WorkOrder[] = [
  // ── Open (regular maintenance) ──
  wo({
    resman_work_order_id: "e1",
    number: "9001",
    unit_number: "0101",
    priority: "Emergency",
    status: "Open",
    category: "Plumbing",
    title: "Burst pipe",
    date_reported: "2026-07-11", // 10 days old
    callback_status: "confirmed",
  }),
  wo({
    resman_work_order_id: "n1",
    number: "9002",
    unit_number: "0202",
    priority: "Normal",
    status: "In Progress",
    category: "Electrical",
    title: "Outlet dead",
    date_reported: "2026-07-19", // 2 days old
  }),
  wo({
    resman_work_order_id: "n2",
    number: "9003",
    unit_number: "0303",
    priority: "Sky High", // unknown → folds into the Normal band
    status: "Open",
    category: "HVAC",
    title: "AC weak",
    date_reported: "2026-07-15", // 6 days old
  }),
  // Make-ready BY CATEGORY (flag unset): must stay off Open and Closed.
  wo({
    resman_work_order_id: "mrcat",
    number: "9004",
    unit_number: "0644",
    status: "Open",
    category: "Make Ready Maintenance",
    title: "Turn general",
  }),

  // ── Make-ready stages ──
  wo({
    resman_work_order_id: "mr1",
    unit_number: "0644",
    is_make_ready: true,
    status: "Completed",
    title: "Trash Out",
    date_reported: "2026-06-20",
    date_completed: "2026-06-25",
  }),
  wo({
    resman_work_order_id: "mr2",
    unit_number: "0644",
    is_make_ready: true,
    status: "On Hold", // parked → blocked
    title: "Punch List",
    date_reported: "2026-07-01",
  }),
  wo({
    resman_work_order_id: "mr3",
    unit_number: "0700",
    is_make_ready: true,
    status: "Open", // fresh and moving — not blocked
    title: "Final Inspection and Cleaning",
    date_reported: "2026-07-18",
  }),
  wo({
    resman_work_order_id: "mr4",
    unit_number: "0800",
    is_make_ready: true,
    status: "Open",
    title: "Cleaning",
    date_reported: "2026-07-10",
  }),

  // ── Closed (regular maintenance) ──
  wo({
    resman_work_order_id: "c1",
    unit_number: "0101",
    status: "Completed",
    category: "Plumbing",
    title: "Leak fixed",
    date_reported: "2026-07-10",
    date_completed: "2026-07-20", // this week, 10 days to close
  }),
  wo({
    resman_work_order_id: "c2",
    unit_number: "0202",
    status: "Closed",
    category: "Appliance",
    title: "Fridge swapped",
    date_reported: "2026-07-01",
    date_completed: "2026-07-03", // this month, not this week, 2 days
  }),
  wo({
    resman_work_order_id: "c3",
    unit_number: "0303",
    status: "Completed",
    category: "HVAC",
    title: "Old filter job",
    date_reported: "2026-03-29",
    date_completed: "2026-04-01", // outside the 60-day list window, 3 days
  }),
  // Closed make-ready by category: excluded from the Closed board too.
  wo({
    resman_work_order_id: "mrclosed",
    unit_number: "0644",
    status: "Completed",
    category: "Make Ready Not Complete",
    title: "Old turn",
    date_reported: "2026-07-14",
    date_completed: "2026-07-20",
  }),
];

const DATA = buildWorkData(ORDERS, UNITS);

describe("open board", () => {
  const board = buildOpenBoard(DATA, NOW);

  test("bands by priority, Emergency first, unknown folded into Normal", () => {
    expect(board.bands.map((b) => b.priority)).toEqual(["Emergency", "Normal"]);
    expect(board.bands[1].rows.map((r) => r.id)).toEqual(["n2", "n1"]); // oldest first
  });

  test("make-ready tickets never appear, even when only the category says so", () => {
    const ids = board.bands.flatMap((b) => b.rows.map((r) => r.id));
    expect(ids).not.toContain("mrcat");
    expect(ids).not.toContain("mr2");
  });

  test("metrics: count, emergencies, average age, callbacks", () => {
    expect(board.openCount).toBe(3);
    expect(board.emergencyCount).toBe(1);
    expect(board.avgAgeDays).toBe(6); // round((10 + 2 + 6) / 3)
    expect(board.callbackCount).toBe(1);
    expect(board.bands[0].rows[0].isCallback).toBe(true);
  });
});

describe("make-ready board", () => {
  const board = buildMakeReadyBoard(DATA, NOW);

  test("orders by soonest move-in, undated last", () => {
    expect(board.rows.map((r) => r.unitNumber)).toEqual(["0700", "0644", "0800"]);
  });

  test("stage progress and blocked detection", () => {
    const u644 = board.rows.find((r) => r.unitNumber === "0644");
    expect(u644?.completedStages).toBe(1); // Trash Out done
    expect(u644?.currentStage).toBe("punch");
    expect(u644?.blockedStages).toEqual(["punch"]); // On Hold = parked
    const u700 = board.rows.find((r) => r.unitNumber === "0700");
    expect(u700?.blockedStages).toEqual([]); // fresh open stage isn't blocked
  });

  test("metrics: turns in progress, ready units, late for move-in, blocked", () => {
    expect(board.turnsInProgress).toBe(2); // 0644 + 0700; 0800 is Ready
    expect(board.readyUnits).toBe(1);
    expect(board.lateForMoveIn).toBe(1); // 0700's move-in is past
    expect(board.blockedCount).toBe(1);
  });

  test("urgency chips only for the urgent-now brackets", () => {
    const u700 = board.rows.find((r) => r.unitNumber === "0700");
    expect(u700?.urgency).toBe("overdue");
    expect(u700?.showsUrgency).toBe(true);
    const u800 = board.rows.find((r) => r.unitNumber === "0800");
    expect(u800?.isReady).toBe(true);
  });
});

describe("closed board", () => {
  const board = buildClosedBoard(DATA, NOW);

  test("lists recent closes newest first, inside the 60-day window", () => {
    expect(board.rows.map((r) => r.id)).toEqual(["c1", "c2"]); // c3 too old
  });

  test("excludes make-ready closes", () => {
    expect(board.rows.map((r) => r.id)).not.toContain("mrclosed");
  });

  test("metrics: this week, this month, average days to close", () => {
    expect(board.closedThisWeek).toBe(1); // c1 on Mon Jul 20
    expect(board.closedThisMonth).toBe(2); // c1 + c2
    expect(board.avgDaysToClose).toBe(5); // (10 + 2 + 3) / 3
  });
});

describe("makeReadySnapshot (Today card)", () => {
  test("summarizes turns and this week's move-ins", () => {
    const snap = makeReadySnapshot(DATA, NOW);
    expect(snap).toEqual({
      turnsInProgress: 2,
      moveInsThisWeek: 2, // 0644 (Jul 22) + 0700 (Jul 20)
      lateForMoveIn: 1,
      blockedCount: 1,
      readyUnits: 1,
    });
  });

  test("returns null when there are no turns at all (card stays hidden)", () => {
    // Both make-ready signals must go: the flag AND the category fold.
    const noTurns = buildWorkData(
      ORDERS.filter((o) => !o.is_make_ready && !/make.?ready/i.test(o.category)),
      UNITS,
    );
    expect(makeReadySnapshot(noTurns, NOW)).toBeNull();
  });
});

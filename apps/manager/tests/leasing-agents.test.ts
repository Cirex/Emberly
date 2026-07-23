import { describe, expect, test } from "bun:test";
import { ManagerLeaseSchema, type ManagerLease } from "@/lib/api/leases";
import { buildLeasingAgentBoard } from "@/lib/derived/leasing-agents";
import { addDays, startOfDay } from "@/lib/derived/time";

/** Tuesday, July 21 2026 — week runs Mon Jul 20 – Sun Jul 26. */
const NOW = new Date("2026-07-21T12:00:00").getTime();

function day(offset: number): string {
  const d = new Date(startOfDay(addDays(NOW, offset)));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let seq = 0;
function lease(fields: Partial<ManagerLease>): ManagerLease {
  seq += 1;
  return ManagerLeaseSchema.parse({ id: `lease-${seq}`, ...fields });
}

const LEASES: ManagerLease[] = [
  // C. Mercer: a move-in this week, an open app last week, a signed app this month.
  lease({ leasingAgent: "C. Mercer", applicationDate: day(-1), moveInDate: day(0) }),
  lease({ leasingAgent: "C. Mercer", applicationDate: day(-3) }),
  lease({ leasingAgent: "C. Mercer", applicationDate: day(-20), signedDate: day(-2) }),
  // T. Vaughn: an open app last week + a stalled one from 25 days ago.
  lease({ leasingAgent: "T. Vaughn", applicationDate: day(-5) }),
  lease({ leasingAgent: "T. Vaughn", applicationDate: day(-25) }),
  // Office / unattributed: a move-in last week.
  lease({ leasingAgent: "", applicationDate: day(-2), moveInDate: day(-1) }),
];

describe("buildLeasingAgentBoard", () => {
  const board = buildLeasingAgentBoard(LEASES, NOW);
  const mercer = board.rows.find((r) => r.agent === "C. Mercer")!;
  const vaughn = board.rows.find((r) => r.agent === "T. Vaughn")!;
  const office = board.rows.find((r) => r.isOffice)!;

  test("per-agent window counts, conversion, funnel, and median app→keys", () => {
    expect(mercer.appsThisWeek).toBe(1);
    expect(mercer.appsLastWeek).toBe(1);
    expect(mercer.appsThisMonth).toBe(3);
    expect(mercer.apps90).toBe(3);
    expect(mercer.moveIns90).toBe(1);
    expect(mercer.conversionPct).toBeCloseTo(33.33, 1);
    expect(mercer.medianAppToKeysDays).toBe(1);
    expect(mercer.funnel).toEqual({ applied: 1, approved: 0, signed: 1, movedIn: 1 });
  });

  test("producers rank by volume, office trails unranked", () => {
    expect(board.rows.map((r) => r.agent)).toEqual(["C. Mercer", "T. Vaughn", ""]);
    expect(mercer.rank).toBe(1);
    expect(vaughn.rank).toBe(2);
    expect(office.rank).toBeNull();
  });

  test("flags: best converter, low volume below the volume floor", () => {
    expect(mercer.flag).toBe("best");
    expect(vaughn.flag).toBe("lowVolume"); // only 2 apps in 90d
    expect(office.flag).toBe("lowVolume");
  });

  test("property totals across all agents", () => {
    expect(board.appsThisWeek).toBe(1);
    expect(board.appsLastWeek).toBe(3);
    expect(board.appsThisMonth).toBe(5);
    expect(board.moveIns90).toBe(2);
    expect(board.appsPerWeek).toHaveLength(8);
  });

  test("stalled queue surfaces open apps older than a week", () => {
    expect(board.stalled).toHaveLength(1);
    expect(board.stalled[0].agent).toBe("T. Vaughn");
    expect(board.stalled[0].ageDays).toBe(25);
  });
});

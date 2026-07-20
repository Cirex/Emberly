/**
 * My Day path engine tests: urgent-trade detection, priority ranking, unit
 * batching order, and the greeting/day-key helpers. Fixtures flow through the
 * real schema + parser like the other derived suites.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { WorkOrderSchema, type WorkOrder } from "@/lib/api/work-orders";
import { parseWorkOrder } from "@/lib/derived/parse";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import {
  buildPath,
  dayKeyOf,
  greetingFor,
  isEmergency,
  priorityRank,
  rankUnits,
  scoreUnit,
  techMatches,
  unitCandidatesOf,
  urgentTrade,
  type PathPoint,
} from "@/lib/derived/my-path";

let seq = 0;
function wo(fields: Partial<WorkOrder> = {}): ParsedWorkOrder {
  seq += 1;
  return parseWorkOrder(
    WorkOrderSchema.parse({ resman_work_order_id: `wo-${seq}`, number: String(seq), ...fields }),
  );
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-18T12:00:00").getTime();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

describe("urgentTrade", () => {
  test("hvac from title and tags", () => {
    expect(urgentTrade(wo({ title: "AC not cooling house" }))).toBe("hvac");
    expect(urgentTrade(wo({ title: "No heat in bedroom" }))).toBe("hvac");
    expect(urgentTrade(wo({ title: "fan broken", tags: ["HVAC"] }))).toBe("hvac");
  });
  test("leak / clog / electrical", () => {
    expect(urgentTrade(wo({ title: "Kitchen sink leaking under cabinet" }))).toBe("leak");
    expect(urgentTrade(wo({ title: "Toilet clogged, plunger not working" }))).toBe("clog");
    expect(urgentTrade(wo({ title: "Outlets dead, breaker keeps tripping" }))).toBe("electrical");
  });
  test("hvac outranks later trades when both match", () => {
    expect(urgentTrade(wo({ title: "AC condensation line leaking" }))).toBe("hvac");
  });
  test("word boundaries: 'replace' is not AC, 'operate' is not a rat", () => {
    expect(urgentTrade(wo({ title: "Replace blinds in bedroom" }))).toBe(null);
    expect(urgentTrade(wo({ title: "Door will not operate smoothly" }))).toBe(null);
  });
});

describe("priorityRank / isEmergency", () => {
  test("ordering", () => {
    expect(priorityRank("Emergency")).toBe(0);
    expect(priorityRank("High")).toBe(1);
    expect(priorityRank("Urgent")).toBe(1);
    expect(priorityRank("Normal")).toBe(2);
    expect(priorityRank("whatever")).toBe(2);
    expect(priorityRank("Low")).toBe(3);
  });
  test("isEmergency", () => {
    expect(isEmergency(wo({ priority: "EMERGENCY" }))).toBe(true);
    expect(isEmergency(wo({ priority: "High" }))).toBe(false);
  });
});

describe("techMatches", () => {
  test("case and space tolerant, empty never matches", () => {
    expect(techMatches("quintez harden", wo({ technician: "Quintez Harden" }))).toBe(true);
    expect(techMatches("  Quintez Harden ", wo({ technician: "Quintez Harden" }))).toBe(true);
    expect(techMatches("", wo({ technician: "Quintez Harden" }))).toBe(false);
    expect(techMatches("Jamie Lopez", wo({ technician: "Quintez Harden" }))).toBe(false);
  });
});

describe("rankUnits", () => {
  test("emergency › urgent trade › priority › age, one candidate per unit", () => {
    const pool = [
      wo({ unit_number: "A-1", title: "Blinds broken", priority: "Normal", date_reported: iso(20) }),
      wo({ unit_number: "B-2", title: "Sink leaking", priority: "Normal", date_reported: iso(1) }),
      wo({ unit_number: "C-3", title: "Screen door off track", priority: "High", date_reported: iso(3) }),
      wo({ unit_number: "D-4", title: "Water heater out", priority: "Emergency", date_reported: iso(0) }),
      wo({ unit_number: "A-1", title: "Also a clogged drain here", priority: "Normal", date_reported: iso(2) }),
    ];
    const ranked = rankUnits(pool);
    // Emergency first; then the trade units by AGE (A-1's oldest ticket is 20d
    // vs B-2's 1d); then the tradeless High.
    expect(ranked.map((c) => c.unitNumber)).toEqual(["D-4", "A-1", "B-2", "C-3"]);
    // A-1 grouped both of its work orders; the clog (trade) sorted first inside.
    const a1 = ranked.find((c) => c.unitNumber === "A-1")!;
    expect(a1.workOrders).toHaveLength(2);
    expect(a1.workOrders[0].title).toContain("clogged");
    expect(a1.trade).toBe("clog");
  });

  test("same tier falls back to oldest first", () => {
    const pool = [
      wo({ unit_number: "N-1", title: "Leaky faucet", date_reported: iso(2) }),
      wo({ unit_number: "N-2", title: "Shower dripping", date_reported: iso(9) }),
    ];
    expect(rankUnits(pool).map((c) => c.unitNumber)).toEqual(["N-2", "N-1"]);
  });

  test("blank units are skipped", () => {
    expect(rankUnits([wo({ unit_number: "  ", title: "Leak" })])).toHaveLength(0);
  });
});

const candOf = (fields: Partial<WorkOrder>) => unitCandidatesOf([wo(fields)])[0];

describe("scoreUnit", () => {
  test("trade weights: water > hvac > electrical > none (fresh Normal, single ticket)", () => {
    const water = scoreUnit(candOf({ unit_number: "1", title: "Sink leaking", date_reported: iso(1) }), NOW);
    const hvac = scoreUnit(candOf({ unit_number: "2", title: "AC not cooling", date_reported: iso(1) }), NOW);
    const elec = scoreUnit(candOf({ unit_number: "3", title: "Breaker keeps tripping", date_reported: iso(1) }), NOW);
    const none = scoreUnit(candOf({ unit_number: "4", title: "Blinds broken", date_reported: iso(1) }), NOW);
    expect(water).toBeGreaterThan(hvac);
    expect(hvac).toBeGreaterThan(elec);
    expect(elec).toBeGreaterThan(none);
  });

  test("fresh HVAC beats a fresh Normal-no-tag, but a very old Normal climbs past", () => {
    const freshHvac = scoreUnit(candOf({ unit_number: "h", title: "AC out", date_reported: iso(1) }), NOW);
    const freshNormal = scoreUnit(candOf({ unit_number: "n", title: "Cabinet door loose", date_reported: iso(1) }), NOW);
    const oldNormal = scoreUnit(candOf({ unit_number: "o", title: "Cabinet door loose", date_reported: iso(90) }), NOW);
    expect(freshHvac).toBeGreaterThan(freshNormal);
    expect(oldNormal).toBeGreaterThan(freshHvac); // ~90 days climbs past a fresh HVAC
  });

  test("a callback adds a small fixed bump", () => {
    const noCb = scoreUnit(candOf({ unit_number: "a", title: "AC out", date_reported: iso(1) }), NOW);
    const cb = scoreUnit(candOf({ unit_number: "b", title: "AC out", date_reported: iso(1), callback_status: "possible" }), NOW);
    expect(cb - noCb).toBeCloseTo(12, 5);
  });

  test("a multi-ticket unit outscores an otherwise-identical single", () => {
    const single = scoreUnit(candOf({ unit_number: "s", title: "AC out", date_reported: iso(1) }), NOW);
    const stacked = scoreUnit(
      unitCandidatesOf([
        wo({ unit_number: "t", title: "AC out", date_reported: iso(1) }),
        wo({ unit_number: "t", title: "Also blinds", date_reported: iso(1) }),
      ])[0],
      NOW,
    );
    expect(stacked).toBeGreaterThan(single);
  });
});

describe("buildPath", () => {
  test("nearby unit is walked before an equal-score far one", () => {
    const pool = [
      wo({ unit_number: "seed", title: "Pipe burst flooding", priority: "High", date_reported: iso(1) }),
      wo({ unit_number: "near", title: "Blinds broken", date_reported: iso(5) }),
      wo({ unit_number: "far", title: "Blinds broken", date_reported: iso(5) }),
    ];
    const centers = new Map<string, PathPoint>([
      ["seed", { x: 0, y: 0 }],
      ["near", { x: 10, y: 0 }],
      ["far", { x: 1000, y: 1000 }],
    ]);
    const path = buildPath(pool, { centers, nowMs: NOW, size: 12 });
    expect(path.map((c) => c.unitNumber)).toEqual(["seed", "near", "far"]);
  });

  test("a big score gap (a leak) still leads a nearby Normal", () => {
    const pool = [
      wo({ unit_number: "seed", title: "Pipe burst flooding", priority: "High", date_reported: iso(1) }),
      wo({ unit_number: "farLeak", title: "Water heater leaking everywhere", date_reported: iso(1) }),
      wo({ unit_number: "nearNormal", title: "Blinds broken", date_reported: iso(1) }),
    ];
    const centers = new Map<string, PathPoint>([
      ["seed", { x: 0, y: 0 }],
      ["farLeak", { x: 1000, y: 1000 }],
      ["nearNormal", { x: 10, y: 0 }],
    ]);
    const path = buildPath(pool, { centers, nowMs: NOW, size: 12 });
    // The far leak's score gap beats the near Normal despite the longer walk.
    expect(path.map((c) => c.unitNumber)).toEqual(["seed", "farLeak", "nearNormal"]);
  });

  test("caps at size and never drops centerless units on score", () => {
    const pool = Array.from({ length: 15 }, (_, i) =>
      wo({ unit_number: `U-${i}`, title: "Blinds broken", date_reported: iso(i + 1) }),
    );
    // No centers at all → distance neutral, pure score order (oldest first).
    const path = buildPath(pool, { centers: new Map(), nowMs: NOW, size: 12 });
    expect(path).toHaveLength(12);
    expect(path[0].unitNumber).toBe("U-14"); // oldest = highest age bonus
  });
});

describe("day helpers", () => {
  test("dayKeyOf is local-calendar stable", () => {
    expect(dayKeyOf(new Date("2026-07-18T00:05:00").getTime())).toBe("2026-07-18");
    expect(dayKeyOf(new Date("2026-07-18T23:55:00").getTime())).toBe("2026-07-18");
  });
  test("greeting windows", () => {
    expect(greetingFor(new Date("2026-07-18T08:00:00").getTime())).toBe("Good morning");
    expect(greetingFor(new Date("2026-07-18T13:00:00").getTime())).toBe("Good afternoon");
    expect(greetingFor(new Date("2026-07-18T17:30:00").getTime())).toBe("Good evening");
  });
});

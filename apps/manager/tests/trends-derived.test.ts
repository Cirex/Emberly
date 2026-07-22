/**
 * Trends derived-engine tests. Fixtures flow through the real zod schema
 * (SnapshotSchema) so defaults match production, against fixed "now" values
 * so window math is deterministic.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { SnapshotSchema, type Snapshot } from "@/lib/api/snapshots";
import {
  MIN_SPARK_POINTS,
  buildMonthCompare,
  collectionsRatePct,
  rangeDelta,
  rangeStartIso,
  seriesBeganDate,
  seriesOf,
  sliceRange,
  sparkValues,
  trendMoney,
  yoyDelta,
} from "@/lib/derived/trends";

const NOW = Date.UTC(2026, 6, 21, 12); // 2026-07-21 noon UTC

function snap(date: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return SnapshotSchema.parse({ date, occupancyPct: 90, ...overrides });
}

/** `days` consecutive snapshots ending on `endIso`, occupancy 90. */
function dailyRun(endIso: string, days: number, overrides: Partial<Snapshot> = {}): Snapshot[] {
  const end = Date.parse(`${endIso}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    snap(new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10), overrides),
  );
}

describe("ranges", () => {
  test("rangeStartIso: calendar months for 12m/3m, 30 calendar days for 30d", () => {
    expect(rangeStartIso(NOW, "12m")).toBe("2025-07-21");
    expect(rangeStartIso(NOW, "3m")).toBe("2026-04-21");
    expect(rangeStartIso(NOW, "30d")).toBe("2026-06-21");
  });

  test("sliceRange keeps the window floor inclusive", () => {
    const snapshots = [snap("2026-04-20"), snap("2026-04-21"), snap("2026-07-01")];
    expect(sliceRange(snapshots, "3m", NOW).map((s) => s.date)).toEqual([
      "2026-04-21",
      "2026-07-01",
    ]);
  });
});

describe("series", () => {
  test("seriesOf skips null days; seriesBeganDate reports the first real one", () => {
    const snapshots = [
      snap("2026-07-01", { balanceTotal: null }),
      snap("2026-07-02", { balanceTotal: 100 }),
      snap("2026-07-03", { balanceTotal: null }),
      snap("2026-07-04", { balanceTotal: 90 }),
    ];
    const pick = (s: Snapshot) => s.balanceTotal;
    expect(seriesOf(snapshots, pick)).toEqual([
      { date: "2026-07-02", value: 100 },
      { date: "2026-07-04", value: 90 },
    ]);
    expect(seriesBeganDate(snapshots, pick)).toBe("2026-07-02");
    expect(seriesBeganDate(snapshots, (s) => s.utilityDue)).toBeNull();
  });

  test("rangeDelta is last-minus-first over the drawn window", () => {
    expect(rangeDelta([])).toBeNull();
    expect(
      rangeDelta([
        { date: "2026-07-01", value: 54.3 },
        { date: "2026-07-10", value: 48.2 },
      ]),
    ).toEqual({ last: 48.2, delta: expect.closeTo(-6.1) });
  });

  test("yoyDelta finds the snapshot nearest one year back, within tolerance", () => {
    const snapshots = [
      snap("2025-07-25", { occupancyPct: 90.1 }), // 4 days off the target — in tolerance
      snap("2026-07-21", { occupancyPct: 92.4 }),
    ];
    expect(yoyDelta(snapshots, (s) => s.occupancyPct)).toBeCloseTo(2.3);

    // Nothing within ±15 days of a year ago → null.
    expect(
      yoyDelta([snap("2026-05-01"), snap("2026-07-21")], (s) => s.occupancyPct),
    ).toBeNull();
    expect(yoyDelta([], (s) => s.occupancyPct)).toBeNull();
  });
});

describe("sparklines", () => {
  test("gate: null under 14 daily points, values from the last 30 days after", () => {
    expect(MIN_SPARK_POINTS).toBe(14);
    const thirteen = dailyRun("2026-07-21", 13);
    expect(sparkValues(thirteen, (s) => s.occupancyPct, NOW)).toBeNull();

    const fourteen = dailyRun("2026-07-21", 14);
    const values = sparkValues(fourteen, (s) => s.occupancyPct, NOW);
    expect(values).toHaveLength(14);
    expect(values?.every((v) => v === 90)).toBe(true);
  });

  test("old history outside the 30-day window never satisfies the gate", () => {
    const stale = dailyRun("2026-05-01", 40); // plenty of points, all too old
    expect(sparkValues(stale, (s) => s.occupancyPct, NOW)).toBeNull();
  });
});

describe("this month vs last", () => {
  test("collectionsRatePct is 1 − (0-30 balance ÷ rent roll), in %", () => {
    expect(
      collectionsRatePct(snap("2026-07-21", { balance0To30: 54_000, rentRoll: 1_000_000 })),
    ).toBeCloseTo(94.6);
    expect(collectionsRatePct(snap("2026-07-21", { balance0To30: 100 }))).toBeNull();
    expect(
      collectionsRatePct(snap("2026-07-21", { balance0To30: 100, rentRoll: 0 })),
    ).toBeNull();
  });

  test("buildMonthCompare compares the two months' closing snapshots", () => {
    const snapshots = [
      // June: an early row that must NOT win, then the month's close.
      snap("2026-06-10", { balance0To30: 90_000, rentRoll: 1_000_000, delinquentUnits: 80 }),
      snap("2026-06-30", { balance0To30: 62_000, rentRoll: 1_000_000, delinquentUnits: 70 }),
      // July: latest non-null wins even when a later row is null.
      snap("2026-07-20", { balance0To30: 54_000, rentRoll: 1_000_000, delinquentUnits: 61 }),
      snap("2026-07-21", { balance0To30: null, rentRoll: null, delinquentUnits: null }),
    ];
    const compare = buildMonthCompare(snapshots, NOW);
    expect(compare.collections).toEqual({
      current: 94.6,
      previous: 93.8,
      delta: expect.closeTo(0.8),
      upIsGood: true,
    });
    expect(compare.delinquentUnits).toEqual({
      current: 61,
      previous: 70,
      delta: -9,
      upIsGood: false,
    });
  });

  test("a missing month yields null rows, never invented numbers", () => {
    const julyOnly = [snap("2026-07-20", { balance0To30: 54_000, rentRoll: 1_000_000, delinquentUnits: 61 })];
    const compare = buildMonthCompare(julyOnly, NOW);
    expect(compare.collections).toBeNull();
    expect(compare.delinquentUnits).toBeNull();
  });
});

describe("formatting", () => {
  test("trendMoney: k under a million, M over, plain under a thousand", () => {
    expect(trendMoney(48_200)).toBe("$48.2k");
    expect(trendMoney(1_090_000)).toBe("$1.09M");
    expect(trendMoney(590)).toBe("$590");
    expect(trendMoney(-6_100)).toBe("-$6.1k");
    expect(trendMoney(null)).toBe("—");
  });
});

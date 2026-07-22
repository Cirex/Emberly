/**
 * Owner-report derived helpers + schema tests. Fixtures flow through the real
 * zod schemas (OwnerReportSchema) so defaults match production.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { OwnerReportSchema, ReportSummarySchema, type ReportSummary } from "@/lib/api/reports";
import {
  compactMoney,
  latestReport,
  pastReportStats,
  pastReports,
  reportHeadlineParts,
  reportMonthName,
  reportMonthYearLabel,
} from "@/lib/derived/reports";

function summary(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return ReportSummarySchema.parse({
    occupancyPct: 92.4,
    occupancyMomDeltaPts: 1.1,
    collectionsRatePct: 94.66,
    collected: 1240000,
    billed: 1310000,
    balanceTotal: 48200,
    balanceMomDelta: -6100,
    turnsCompleted: 9,
    ...overrides,
  });
}

describe("schema", () => {
  test("missing summary fields default to null, not parse failures", () => {
    const parsed = OwnerReportSchema.parse({ period: "2026-07", summary: {} });
    expect(parsed.generatedAt).toBeNull();
    expect(parsed.summary.occupancyPct).toBeNull();
    expect(parsed.summary.turnsCompleted).toBeNull();
  });
});

describe("formatting", () => {
  test("compactMoney matches the mockup's shapes", () => {
    expect(compactMoney(1240000)).toBe("$1.24M");
    expect(compactMoney(48200)).toBe("$48.2k");
    expect(compactMoney(6100)).toBe("$6.1k");
    expect(compactMoney(412)).toBe("$412");
    expect(compactMoney(-6100)).toBe("−$6.1k");
  });

  test("month labels localize", () => {
    expect(reportMonthName("2026-07", "en")).toBe("July");
    expect(reportMonthName("2026-07", "es")).toBe("julio");
    expect(reportMonthYearLabel("2026-06", "en")).toBe("June 2026");
  });
});

describe("headline", () => {
  test("full summary yields the mockup's four fragments in order", () => {
    expect(reportHeadlineParts(summary())).toEqual([
      { key: "occupancy", params: { value: "92.4% ▲" } },
      { key: "collected", params: { amount: "$1.24M" } },
      { key: "delinquencyDown", params: { amount: "$6.1k" } },
      { key: "turns", params: { count: 9 } },
    ]);
  });

  test("null fields drop their fragment (honest deltas)", () => {
    const parts = reportHeadlineParts(
      summary({ occupancyMomDeltaPts: null, collected: null, balanceMomDelta: null }),
    );
    expect(parts).toEqual([
      { key: "occupancy", params: { value: "92.4%" } }, // no arrow without a delta
      { key: "turns", params: { count: 9 } },
    ]);
  });

  test("a rising balance flips to delinquencyUp", () => {
    const parts = reportHeadlineParts(summary({ balanceMomDelta: 2500 }));
    expect(parts).toContainEqual({ key: "delinquencyUp", params: { amount: "$2.5k" } });
  });
});

describe("archive slicing", () => {
  const reports = [
    OwnerReportSchema.parse({ period: "2026-07", summary: {} }),
    OwnerReportSchema.parse({ period: "2026-06", summary: {} }),
    OwnerReportSchema.parse({ period: "2026-05", summary: {} }),
  ];

  test("latest/past split the newest-first list", () => {
    expect(latestReport(reports)?.period).toBe("2026-07");
    expect(pastReports(reports).map((r) => r.period)).toEqual(["2026-06", "2026-05"]);
    expect(latestReport([])).toBeNull();
    expect(pastReports([])).toEqual([]);
  });

  test("past-report stats drop null fields", () => {
    expect(pastReportStats(summary())).toEqual([
      { key: "occupancy", value: "92.4%" },
      { key: "collections", value: "94.7%" },
    ]);
    expect(pastReportStats(summary({ occupancyPct: null, collectionsRatePct: null }))).toEqual([]);
  });
});

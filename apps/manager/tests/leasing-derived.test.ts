/**
 * Leasing derived-engine tests. All fixtures flow through the real zod
 * schemas (ManagerLeaseSchema / ResmanUnitSchema) so defaults and coercions
 * match production, against a fixed local-time "now" so calendar math is
 * deterministic.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { ManagerLeaseSchema, type ManagerLease } from "@/lib/api/leases";
import { ResmanUnitSchema, type ResmanUnit } from "@/lib/api/units";
import {
  buildExpirationRows,
  buildForecastRows,
  buildLeasingMetrics,
  buildMonthlyFlow,
  buildPipelineRows,
  buildTodayFeed,
  buildTodayMetrics,
  buildVacancyRows,
  expiringByMonth,
  hasLaterLease,
  isApprovedApproval,
  isCurrentStatus,
  isDeniedStatus,
  isEndedStatus,
  isLeaseSentSignal,
  isPipelineStatus,
  isReadyAvailability,
  isScreeningApproval,
  occupancySnapshot,
  pipelineStageOf,
  primaryTenantName,
  shortMoney,
  shortPct,
  signedMoney,
  unitFactsIndex,
  unitFactsOf,
  vacancySummary,
} from "@/lib/derived/leasing";
import { addDays, calendarDaysBetween, monthStartShift, parseDay, startOfDay } from "@/lib/derived/time";

// Tue 2026-07-21 noon, device-local.
const NOW = new Date("2026-07-21T12:00:00").getTime();

/** Local "YYYY-MM-DD" for a day offset from NOW. */
function day(offset: number): string {
  const d = new Date(startOfDay(addDays(NOW, offset)));
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

let seq = 0;
function lease(fields: Partial<ManagerLease> = {}): ManagerLease {
  seq += 1;
  return ManagerLeaseSchema.parse({ id: `lease-${seq}`, ...fields });
}

function unit(fields: Partial<ResmanUnit> & { number: string }): ResmanUnit {
  return ResmanUnitSchema.parse({ resman_unit_id: `unit-${fields.number}`, ...fields });
}

// ── Time helpers ────────────────────────────────────────────────────────────

describe("time helpers", () => {
  test("parseDay reads YYYY-MM-DD as LOCAL midnight", () => {
    const ms = parseDay("2026-07-21");
    expect(ms).toBe(new Date(2026, 6, 21).getTime());
  });

  test("parseDay tolerates trailing time and rejects junk", () => {
    expect(parseDay("2026-07-21T00:00:00Z")).toBe(new Date(2026, 6, 21).getTime());
    expect(parseDay(null)).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay("not a date")).toBeNull();
  });

  test("calendarDaysBetween is whole signed days", () => {
    expect(calendarDaysBetween(NOW, addDays(NOW, 3))).toBe(3);
    expect(calendarDaysBetween(NOW, addDays(NOW, -2))).toBe(-2);
  });

  test("monthStartShift crosses year boundaries", () => {
    const d = new Date(monthStartShift(NOW, 6)); // Jul 2026 + 6 → Jan 2027
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

// ── Status matchers ─────────────────────────────────────────────────────────

describe("status matchers", () => {
  test("denied / cancelled", () => {
    expect(isDeniedStatus("Denied")).toBe(true);
    expect(isDeniedStatus("Application Cancelled")).toBe(true);
    expect(isDeniedStatus("Current")).toBe(false);
  });

  test("ended residencies", () => {
    expect(isEndedStatus("Past")).toBe(true);
    expect(isEndedStatus("Evicted")).toBe(true);
    expect(isEndedStatus("Fulfilled")).toBe(true);
    expect(isEndedStatus("Under Eviction")).toBe(false); // still in residence
    expect(isEndedStatus("Current")).toBe(false);
  });

  test("current is whole-word (never Non-Current / Currently Evicted)", () => {
    expect(isCurrentStatus("Current")).toBe(true);
    expect(isCurrentStatus("current resident")).toBe(true);
    expect(isCurrentStatus("Non-Current")).toBe(false);
    expect(isCurrentStatus("Currently Evicted")).toBe(false);
    expect(isCurrentStatus("Active")).toBe(true);
  });

  test("pipeline-ish statuses", () => {
    expect(isPipelineStatus("Pending")).toBe(true);
    expect(isPipelineStatus("Pending Transfer")).toBe(true);
    expect(isPipelineStatus("Applicant")).toBe(true);
    expect(isPipelineStatus("Future")).toBe(true);
    expect(isPipelineStatus("Current")).toBe(false);
  });

  test("approval matchers", () => {
    expect(isApprovedApproval("Approved")).toBe(true);
    expect(isApprovedApproval("Approved with Conditions")).toBe(true);
    expect(isApprovedApproval("Not Approved")).toBe(false);
    expect(isApprovedApproval("Disapproved")).toBe(false);
    expect(isScreeningApproval("Screening")).toBe(true);
    expect(isScreeningApproval("In Review")).toBe(true);
    expect(isScreeningApproval("Approved")).toBe(false);
  });

  test("lease-sent signal reads either field", () => {
    expect(isLeaseSentSignal("Pending", "Lease Sent")).toBe(true);
    expect(isLeaseSentSignal("Lease Generated", "")).toBe(true);
    expect(isLeaseSentSignal("Pending", "Approved")).toBe(false);
  });

  test("ready availability", () => {
    expect(isReadyAvailability("Ready")).toBe(true);
    expect(isReadyAvailability("Available Now")).toBe(true);
    expect(isReadyAvailability("Not Ready")).toBe(false);
    expect(isReadyAvailability("")).toBe(false);
  });
});

// ── Unit facts ──────────────────────────────────────────────────────────────

describe("unit facts", () => {
  test("occupied via boolean or status prefix; vacant is the explicit complement", () => {
    expect(unitFactsOf(unit({ number: "1", occupied: true })).occupied).toBe(true);
    expect(unitFactsOf(unit({ number: "2", occupancy_status: "Occupied - Notice" })).occupied).toBe(true);
    const vacant = unitFactsOf(unit({ number: "3", occupied: false, occupancy_status: "Vacant" }));
    expect(vacant.occupied).toBe(false);
    expect(vacant.vacant).toBe(true);
  });

  test("holding / excluded units never count for occupancy", () => {
    expect(unitFactsOf(unit({ number: "4", holding_unit: true })).countsForOccupancy).toBe(false);
    expect(unitFactsOf(unit({ number: "5", excluded_from_occupancy: true })).countsForOccupancy).toBe(false);
    expect(unitFactsOf(unit({ number: "6" })).countsForOccupancy).toBe(true);
  });

  test("primaryTenantName falls back to empty", () => {
    const idx = unitFactsIndex([unit({ number: "0212", tenant_names: ["Jordan Wallace", "Sam Wallace"] })]);
    expect(primaryTenantName(idx.get("0212"))).toBe("Jordan Wallace");
    expect(primaryTenantName(idx.get("nope"))).toBe("");
  });
});

// ── Pipeline ────────────────────────────────────────────────────────────────

describe("pipeline", () => {
  const units = unitFactsIndex([
    unit({ number: "0212", tenant_names: ["Jordan Wallace"], classification: "Diamond" }),
    unit({ number: "1114", tenant_names: ["Taylor Brooks"], classification: "Ruby" }),
  ]);

  test("denied and long-settled leases are not pipeline", () => {
    expect(pipelineStageOf(lease({ status: "Denied", applicationDate: day(-3) }), NOW)).toBeNull();
    expect(
      pipelineStageOf(lease({ status: "Current", moveInDate: day(-200), isCurrentLease: true }), NOW),
    ).toBeNull();
  });

  test("recently moved in stays on the board as movedIn", () => {
    expect(pipelineStageOf(lease({ status: "Current", moveInDate: day(0) }), NOW)).toBe("movedIn");
    expect(pipelineStageOf(lease({ status: "Current", moveInDate: day(-6) }), NOW)).toBe("movedIn");
    expect(pipelineStageOf(lease({ status: "Current", moveInDate: day(-8) }), NOW)).toBeNull();
  });

  test("stage precedence: signed > lease sent > approved > screening > application", () => {
    const base = { status: "Pending", moveInDate: day(10) };
    expect(pipelineStageOf(lease({ ...base, signedDate: day(-2) }), NOW)).toBe("signed");
    expect(pipelineStageOf(lease({ ...base, approvalStatus: "Lease Sent" }), NOW)).toBe("leaseSent");
    expect(pipelineStageOf(lease({ ...base, approvalStatus: "Approved" }), NOW)).toBe("approved");
    expect(pipelineStageOf(lease({ ...base, approvalStatus: "Screening" }), NOW)).toBe("screening");
    expect(pipelineStageOf(lease(base), NOW)).toBe("application");
  });

  test("recent application activity qualifies even without a pipeline status", () => {
    expect(pipelineStageOf(lease({ status: "", applicationDate: day(-30) }), NOW)).toBe("application");
    expect(pipelineStageOf(lease({ status: "", applicationDate: day(-150) }), NOW)).toBeNull();
  });

  test("rows join tenants, band imminent move-ins first, sort by stage then date", () => {
    const rows = buildPipelineRows(
      [
        lease({ unitNumber: "1114", status: "Pending", approvalStatus: "Screening", applicationDate: day(-1) }),
        lease({ unitNumber: "0212", status: "Pending", signedDate: day(-3), moveInDate: day(4) }),
      ],
      units,
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].lease.unitNumber).toBe("0212"); // imminent move-in leads
    expect(rows[0].imminent).toBe(true);
    expect(rows[0].tenantName).toBe("Jordan Wallace");
    expect(rows[0].classification).toBe("Diamond");
    expect(rows[1].stage).toBe("screening");
    expect(rows[1].imminent).toBe(false);
  });
});

// ── Expirations ─────────────────────────────────────────────────────────────

describe("expirations", () => {
  const units = unitFactsIndex([unit({ number: "0327", tenant_names: ["Ana Reyes"] })]);

  test("hasLaterLease detects a renewal on the same unit", () => {
    const current = lease({ unitNumber: "0327", status: "Current", startDate: day(-300), endDate: day(20) });
    const renewal = lease({ unitNumber: "0327", status: "Future", startDate: day(21) });
    const denied = lease({ unitNumber: "0327", status: "Denied", startDate: day(30) });
    expect(hasLaterLease(current, [current, renewal])).toBe(true);
    expect(hasLaterLease(current, [current, denied])).toBe(false);
    expect(hasLaterLease(current, [current])).toBe(false);
  });

  test("rows: window, mark-to-market, states, sorted by end date", () => {
    const renewedLease = lease({
      unitNumber: "0327", status: "Current", isCurrentLease: true,
      startDate: day(-300), endDate: day(14), marketRent: 1335, residentRent: 1240,
    });
    const renewal = lease({ unitNumber: "0327", status: "Future", startDate: day(15) });
    const noticeLease = lease({
      unitNumber: "0112", status: "Notice - Unrented", isCurrentLease: true,
      endDate: day(19), moveOutDate: day(19), residentRent: 1100, marketRent: 1100,
    });
    const openLease = lease({
      unitNumber: "0433", status: "Current", isCurrentLease: true,
      endDate: day(5), residentRent: 1200,
    });
    const farOut = lease({ unitNumber: "0999", status: "Current", isCurrentLease: true, endDate: day(120) });
    const past = lease({ unitNumber: "0888", status: "Past", endDate: day(10) });

    const rows = buildExpirationRows(
      [renewedLease, renewal, noticeLease, openLease, farOut, past],
      units, NOW, 90,
    );
    expect(rows.map((r) => r.lease.unitNumber)).toEqual(["0433", "0327", "0112"]);
    expect(rows[0].state).toBe("open");
    expect(rows[1].state).toBe("renewed");
    expect(rows[1].markToMarket).toBe(95);
    expect(rows[1].tenantName).toBe("Ana Reyes");
    expect(rows[2].state).toBe("moveOut");
    expect(rows[0].daysLeft).toBe(5);
  });

  test("expiringByMonth buckets active leases from the current month", () => {
    const buckets = expiringByMonth(
      [
        lease({ status: "Current", isCurrentLease: true, endDate: day(3) }),
        lease({ status: "Current", isCurrentLease: true, endDate: day(45) }),
        lease({ status: "Current", isCurrentLease: true, endDate: day(50) }),
        lease({ status: "Past", endDate: day(45) }), // ended → ignored
      ],
      NOW, 12,
    );
    expect(buckets).toHaveLength(12);
    expect(buckets[0].count).toBe(1);
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(3);
  });
});

// ── Forecast + vacancy ──────────────────────────────────────────────────────

describe("forecast and vacancy", () => {
  const units = [
    unit({ number: "1", occupied: true }),
    unit({ number: "2", occupied: true }),
    unit({ number: "3", occupied: false, occupancy_status: "Vacant", availability: "Ready", market_rent: 1500 }),
    unit({ number: "4", occupied: false, occupancy_status: "Vacant", availability: "Not Ready", market_rent: 1200 }),
    unit({ number: "5", occupied: false, holding_unit: true }), // never counted
  ].map(unitFactsOf);

  test("occupancySnapshot excludes holding/excluded units", () => {
    const snap = occupancySnapshot(units);
    expect(snap.total).toBe(4);
    expect(snap.occupied).toBe(2);
    expect(snap.pct).toBe(50);
  });

  test("forecast rows add scheduled ins and subtract outs per horizon", () => {
    const leases = [
      lease({ status: "Future", moveInDate: day(10) }),
      lease({ status: "Future", moveInDate: day(45) }),
      lease({ status: "Notice", isCurrentLease: true, moveOutDate: day(20) }),
      lease({ status: "Notice - Rented", isCurrentLease: true, endDate: day(80) }), // notice, ends in 90 window
      lease({ status: "Denied", moveInDate: day(5) }), // dead → ignored
    ];
    const rows = buildForecastRows(leases, units, NOW);
    expect(rows.map((r) => r.horizonDays)).toEqual([30, 60, 90]);
    expect(rows[0].moveIns).toBe(1);
    expect(rows[0].moveOuts).toBe(1);
    expect(rows[0].projectedOccupied).toBe(2);
    expect(rows[1].moveIns).toBe(2);
    expect(rows[1].moveOuts).toBe(1);
    expect(rows[2].moveOuts).toBe(2); // explicit date + notice ending in window
    expect(rows[2].projectedPct).toBe(50); // (2 + 2 − 2) / 4
  });

  test("vacancy rows sort by exposure and summarize", () => {
    const rows = buildVacancyRows(units);
    expect(rows.map((r) => r.unitNumber)).toEqual(["3", "4"]);
    expect(rows[0].ready).toBe(true);
    expect(rows[1].ready).toBe(false);
    const summary = vacancySummary(rows);
    expect(summary).toEqual({ count: 2, ready: 1, exposure: 2700 });
  });
});

// ── Today feed + monthly flow ───────────────────────────────────────────────

describe("today feed", () => {
  const units = unitFactsIndex([unit({ number: "0644", tenant_names: ["Rosa Núñez"] })]);

  test("emits move-in / application / signed / move-out events in window, newest first", () => {
    const events = buildTodayFeed(
      [
        lease({ unitNumber: "0644", moveInDate: day(0), residentRent: 1485 }),
        lease({ unitNumber: "1114", applicationDate: day(-1) }),
        lease({ unitNumber: "0212", signedDate: day(-2), residentRent: 1300 }),
        lease({ unitNumber: "0919", moveOutDate: day(40) }), // scheduled ahead
        lease({ unitNumber: "0000", applicationDate: day(-30) }), // outside lookback
        lease({ unitNumber: "0001", status: "Denied", applicationDate: day(-1) }), // dead
      ],
      units, NOW,
    );
    expect(events.map((e) => e.kind)).toEqual(["moveOut", "moveIn", "application", "signed"]);
    expect(events[0].scheduled).toBe(true);
    expect(events[1].tenantName).toBe("Rosa Núñez");
    expect(events[1].rent).toBe(1485);
    expect(events[1].scheduled).toBe(false);
  });

  test("caps the feed", () => {
    const many = Array.from({ length: 40 }, () => lease({ applicationDate: day(-1) }));
    expect(buildTodayFeed(many, units, NOW, { cap: 10 })).toHaveLength(10);
  });
});

describe("monthly flow", () => {
  test("buckets realized move-ins/outs over the trailing months", () => {
    const flow = buildMonthlyFlow(
      [
        lease({ moveInDate: day(-10) }),
        lease({ moveInDate: day(-40) }),
        lease({ moveOutDate: day(-40) }),
        lease({ moveOutDate: day(10) }), // future → not realized
      ],
      NOW, 6,
    );
    expect(flow).toHaveLength(6);
    expect(flow[5].moveIns).toBe(1); // current month
    expect(flow[4].moveIns).toBe(1); // last month
    expect(flow[4].moveOuts).toBe(1);
    expect(flow[5].moveOuts).toBe(0);
  });
});

// ── Formatting + score cards ────────────────────────────────────────────────

describe("formatting", () => {
  test("shortMoney", () => {
    expect(shortMoney(48_200)).toBe("$48.2k");
    expect(shortMoney(590)).toBe("$590");
    expect(shortMoney(1_000_000)).toBe("$1,000k");
    expect(shortMoney(-1500)).toBe("-$1.5k");
    expect(shortMoney(null)).toBe("—");
  });

  test("shortPct and signedMoney", () => {
    expect(shortPct(92.35)).toBe("92.3%");
    expect(signedMoney(95)).toBe("+$95");
    expect(signedMoney(-40)).toBe("-$40");
    expect(signedMoney(0)).toBe("$0");
  });
});

describe("score metrics", () => {
  const units = [
    unit({ number: "1", occupied: true, balance: 2180 }),
    unit({ number: "2", occupied: true, balance: -50 }),
    unit({ number: "3", occupied: false, occupancy_status: "Vacant", availability: "Ready", market_rent: 1500 }),
  ].map(unitFactsOf);
  const unitsIdx = unitFactsIndex([unit({ number: "1" })]);
  const leases = [
    lease({ status: "Pending", approvalStatus: "Approved", applicationDate: day(-5), moveInDate: day(12) }),
    lease({ status: "Pending", approvalStatus: "Screening", applicationDate: day(-2) }),
    lease({ status: "Current", isCurrentLease: true, endDate: day(25), residentRent: 1240, marketRent: 1335 }),
    lease({ status: "Current", isCurrentLease: true, endDate: day(50), residentRent: 1100 }),
    lease({ signedDate: day(-10), residentRent: 1400, status: "Future", moveInDate: day(3) }),
  ];
  const pipelineRows = buildPipelineRows(leases, unitsIdx, NOW);
  const expirationRows90 = buildExpirationRows(leases, unitsIdx, NOW, 90);
  const forecastRows = buildForecastRows(leases, units, NOW);
  const vacancyRows = buildVacancyRows(units);

  test("every leasing mode returns exactly three metrics with resolvable keys", () => {
    for (const mode of ["pipeline", "expirations", "forecast", "vacancy"] as const) {
      const metrics = buildLeasingMetrics({
        mode, pipelineRows, expirationRows90, forecastRows, vacancyRows, leases, nowMs: NOW,
      });
      expect(metrics).toHaveLength(3);
      for (const m of metrics) {
        expect(m.value.length).toBeGreaterThan(0);
        expect(m.labelKey.startsWith("leasing.metrics.")).toBe(true);
      }
    }
  });

  test("pipeline metrics: applicants count and signed-cycle average rent", () => {
    const [applicants, moveIns, avg] = buildLeasingMetrics({
      mode: "pipeline", pipelineRows, expirationRows90, forecastRows, vacancyRows, leases, nowMs: NOW,
    });
    expect(applicants.value).toBe(String(pipelineRows.length));
    expect(moveIns.value).toBe("2"); // both future move-ins inside 30d
    expect(avg.value).toBe("$1,400");
  });

  test("expiration metrics split 30 / 31–60 and count renewals", () => {
    const [next30, days3160] = buildLeasingMetrics({
      mode: "expirations", pipelineRows, expirationRows90, forecastRows, vacancyRows, leases, nowMs: NOW,
    });
    expect(next30.value).toBe("1");
    expect(next30.captionParams?.amount).toBe("$1.2k");
    expect(days3160.value).toBe("1");
  });

  test("today metrics: occupancy, positive balances only, expirations at risk", () => {
    const [occ, balances, moveIns30, expiring60] = buildTodayMetrics({
      units, leases, expirationRows90, nowMs: NOW,
    });
    expect(occ.value).toBe("66.7%");
    expect(balances.value).toBe("$2.2k");
    expect(balances.captionParams?.count).toBe(1);
    expect(moveIns30.value).toBe("2");
    expect(expiring60.value).toBe("2");
  });
});

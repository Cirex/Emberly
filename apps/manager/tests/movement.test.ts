import { describe, expect, test } from "bun:test";
import type { ManagerLease } from "@/lib/api/leases";
import type { UnitFacts } from "@/lib/derived/leasing";
import {
  buildMovementBoard,
  isRealArrival,
  isRealDeparture,
  MOVEMENT_HISTORY_START,
  startOfWeek,
  stayLengthDays,
} from "@/lib/derived/movement";

const NOW = new Date(2026, 7, 15, 12, 0, 0).getTime(); // 2026-08-15 local

let seq = 0;
function lease(over: Partial<ManagerLease> = {}): ManagerLease {
  seq += 1;
  return {
    id: `L${seq}`,
    unitId: `u${seq}`,
    unitNumber: `10${seq}`,
    status: "Current",
    approvalStatus: "Approved",
    applicationDate: null,
    signedDate: null,
    startDate: null,
    startDateChanges: 0,
    endDate: null,
    moveInDate: null,
    moveOutDate: null,
    reasonForLeaving: "",
    leasingAgent: "Dana",
    marketRent: 1000,
    residentRent: 950,
    balance: 0,
    isCurrentLease: true,
    isMostRecentLease: true,
    ...over,
  } as ManagerLease;
}

function unit(over: Partial<UnitFacts> = {}): UnitFacts {
  return {
    unitId: `x${Math.random()}`,
    unitNumber: "100",
    occupied: true,
    vacant: false,
    ready: true,
    countsForOccupancy: true,
    classification: "Ruby",
    marketRent: 1000,
    dateAvailableMs: null,
    bedrooms: 2,
    bathrooms: 1,
    layout: "2×1",
    ...over,
  } as UnitFacts;
}

const board = (leases: ManagerLease[], units: UnitFacts[] = [unit()]) =>
  buildMovementBoard(leases, units, NOW);

describe("what counts as movement", () => {
  test("a Cancelled or Denied lease is never an arrival or a departure", () => {
    for (const status of ["Cancelled", "Denied"]) {
      const l = lease({ status, moveInDate: "2026-03-01", moveOutDate: "2026-02-28" });
      expect(isRealArrival(l)).toBe(false);
      expect(isRealDeparture(l)).toBe(false);
    }
  });

  test("Evicted, Former and Notice to Vacate are real departures; Under Eviction is not", () => {
    expect(isRealDeparture(lease({ status: "Evicted" }))).toBe(true);
    expect(isRealDeparture(lease({ status: "Former" }))).toBe(true);
    expect(isRealDeparture(lease({ status: "Notice to Vacate" }))).toBe(true);
    // The eviction is in flight — the resident is still in the unit.
    expect(isRealDeparture(lease({ status: "Under Eviction" }))).toBe(false);
    expect(isRealDeparture(lease({ status: "Current" }))).toBe(false);
  });

  test("stayLengthDays goes negative exactly when the tenancy never happened", () => {
    expect(stayLengthDays(lease({ moveInDate: "2026-03-01", moveOutDate: "2026-03-31" }))).toBe(30);
    // The signature of a dead application: out before in.
    expect(stayLengthDays(lease({ moveInDate: "2026-03-08", moveOutDate: "2026-03-01" }))).toBe(-7);
    expect(stayLengthDays(lease({ moveInDate: null, moveOutDate: "2026-03-01" }))).toBeNull();
  });
});

describe("buildMovementBoard", () => {
  test("separates real movement from the dead applications that mimic it", () => {
    const leases = [
      // Two real arrivals.
      lease({ status: "Current", moveInDate: "2026-03-05" }),
      lease({ status: "Current", moveInDate: "2026-04-05" }),
      // One real departure.
      lease({ status: "Former", moveInDate: "2025-06-01", moveOutDate: "2026-05-10" }),
      // A denied application, carrying BOTH dates like the real thing.
      lease({ status: "Denied", moveInDate: "2026-03-10", moveOutDate: "2026-03-03" }),
      // A cancelled one.
      lease({ status: "Cancelled", moveInDate: "2026-04-20", moveOutDate: "2026-04-19" }),
    ];
    const b = board(leases);

    expect(b.arrivals).toBe(2);
    expect(b.departures).toBe(1);
    expect(b.net).toBe(1);
    // The raw counts the old board would have shown.
    expect(b.claimedArrivals).toBe(4);
    expect(b.claimedDepartures).toBe(3);
    expect(b.funnel).toEqual({ moved: 2, denied: 1, cancelled: 1, total: 4 });
  });

  test("ignores anything before the history horizon", () => {
    const b = board([
      lease({ status: "Current", moveInDate: "2025-08-01" }),
      lease({ status: "Current", moveInDate: "2026-03-01" }),
    ]);
    expect(b.arrivals).toBe(1);
    expect(new Date(b.fromMs).getFullYear()).toBe(2026);
  });

  test("an explicit horizon overrides the default", () => {
    const leases = [lease({ status: "Current", moveInDate: "2026-06-01" })];
    expect(buildMovementBoard(leases, [unit()], NOW, { historyStart: "2026-07-01" }).arrivals).toBe(0);
    expect(buildMovementBoard(leases, [unit()], NOW, { historyStart: "2026-05-01" }).arrivals).toBe(1);
  });

  test("weeks carry bookings ahead of today and flag them as scheduled; months do not", () => {
    const b = board([
      lease({ status: "Current", moveInDate: "2026-08-10" }),
      lease({ status: "Approved", moveInDate: "2026-09-02" }),
      // Already dead — must not be promised as an arrival.
      lease({ status: "Denied", moveInDate: "2026-09-03" }),
    ]);
    const future = b.weeks.filter((w) => w.scheduled);
    expect(future.length).toBe(1);
    expect(future[0].arrivals).toBe(1);
    expect(b.scheduledArrivals.length).toBe(1);
    // A part-month of bookings beside full months of history would read as a
    // collapse in movement, so months stay historic.
    expect(b.months.every((m) => !m.scheduled)).toBe(true);
  });

  test("counts the expiration wall off current leases only, with their rent", () => {
    const b = board([
      lease({ isCurrentLease: true, endDate: "2026-10-31", residentRent: 900 }),
      lease({ isCurrentLease: true, endDate: "2026-10-05", residentRent: 1100 }),
      lease({ isCurrentLease: true, endDate: "2026-11-30", residentRent: 800 }),
      // Already expired, and a non-current lease: neither is ahead of us.
      lease({ isCurrentLease: true, endDate: "2026-01-01", residentRent: 700 }),
      lease({ isCurrentLease: false, endDate: "2026-12-01", residentRent: 700 }),
    ]);
    expect(b.expiringLeases).toBe(3);
    expect(b.expiringRent).toBe(2800);
    expect(b.expirations.length).toBe(2);
    expect(b.expirations[0].leases).toBe(2);
    expect(b.expirations[0].rent).toBe(2000);
  });

  test("departure reasons and stay bands come from real departures only", () => {
    const b = board([
      lease({ status: "Evicted", moveInDate: "2025-09-01", moveOutDate: "2026-06-01", reasonForLeaving: "Eviction or Problems" }),
      lease({ status: "Former", moveInDate: "2026-05-01", moveOutDate: "2026-06-15", reasonForLeaving: "Lost Job" }),
      // A denial with a reason must not pollute the departure reasons.
      lease({ status: "Denied", moveInDate: "2026-06-10", moveOutDate: "2026-06-03", reasonForLeaving: "Screening Results" }),
    ]);
    expect(b.departureReasons.map((r) => r.key)).toEqual(["Eviction or Problems", "Lost Job"]);
    expect(b.evictionExits).toBe(1);
    expect(b.staySample).toBe(2);
    expect(b.stayBands.find((s) => s.key === "under6mo")?.n).toBe(1);
    expect(b.stayBands.find((s) => s.key === "6to12mo")?.n).toBe(1);
  });

  test("denial and cancellation are measured separately, in days from application", () => {
    const b = board([
      lease({ status: "Denied", applicationDate: "2026-03-01", moveInDate: "2026-03-20", moveOutDate: "2026-03-08", reasonForLeaving: "Screening Results" }),
      lease({ status: "Denied", applicationDate: "2026-04-01", moveInDate: "2026-04-20", moveOutDate: "2026-04-05", reasonForLeaving: "Insufficient Income" }),
      lease({ status: "Cancelled", applicationDate: "2026-05-01", moveInDate: "2026-05-20", moveOutDate: "2026-05-21", reasonForLeaving: "Cancellation" }),
      lease({ status: "Cancelled", applicationDate: "2026-06-01", moveInDate: "2026-06-20", moveOutDate: "2026-06-11", reasonForLeaving: "" }),
    ]);
    expect(b.medianDaysToDeny).toBe(7); // 7 and 4 → median of the sorted pair
    expect(b.medianDaysToCancel).toBe(20);
    expect(b.slowestCancelDays).toBe(20);
    expect(b.denialReasons.map((r) => r.key)).toEqual(["Insufficient Income", "Screening Results"]);
    // Blank and "Cancellation" both count as telling us nothing.
    expect(b.vagueCancellations).toBe(2);
  });

  test("the agent funnel drops books too small to carry a rate", () => {
    const many = (n: number, over: Partial<ManagerLease>) =>
      Array.from({ length: n }, () => lease(over));
    const b = board([
      ...many(6, { status: "Current", moveInDate: "2026-03-01", leasingAgent: "Big" }),
      ...many(4, { status: "Denied", moveInDate: "2026-03-10", moveOutDate: "2026-03-02", leasingAgent: "Big" }),
      ...many(2, { status: "Current", moveInDate: "2026-03-01", leasingAgent: "Small" }),
    ]);
    expect(b.agentFunnel.map((r) => r.agent)).toEqual(["Big"]);
    const big = b.agentFunnel[0];
    expect(big.total).toBe(10);
    expect(big.denialRate).toBeCloseTo(0.4);
    expect(big.cancelRate).toBe(0);
  });

  test("a denial costs nothing when the unit is relet inside the window", () => {
    const b = board([
      lease({ status: "Denied", unitNumber: "A1", moveInDate: "2026-03-10", moveOutDate: "2026-03-02", marketRent: 900 }),
      lease({ status: "Denied", unitNumber: "B2", moveInDate: "2026-03-10", moveOutDate: "2026-03-02", marketRent: 800 }),
      lease({ status: "Current", unitNumber: "A1", moveInDate: "2026-04-01" }),
    ]);
    expect(b.deniedUnits).toBe(2);
    expect(b.deniedUnitsRelet).toBe(1);
    expect(b.deniedRent).toBe(1700);
  });

  test("occupancy comes from units that count, not from lease rows", () => {
    const b = board(
      [],
      [unit({ occupied: true }), unit({ occupied: false }), unit({ occupied: true, countsForOccupancy: false })],
    );
    expect(b.occupancy.total).toBe(2);
    expect(b.occupancy.occupied).toBe(1);
    expect(b.occupancy.vacant).toBe(1);
    expect(b.occupancy.pct).toBe(50);
  });

  test("an empty board reports zeroes rather than NaN", () => {
    const b = buildMovementBoard([], [], NOW);
    expect(b.arrivals).toBe(0);
    expect(b.net).toBe(0);
    expect(b.occupancy.pct).toBe(0);
    expect(b.medianStayDays).toBeNull();
    expect(b.medianDaysToDeny).toBeNull();
    expect(b.funnel.total).toBe(0);
    expect(b.weeks).toEqual([]);
  });
});

describe("startOfWeek", () => {
  test("snaps to Monday and is idempotent", () => {
    const sunday = new Date(2026, 7, 16, 23, 0, 0).getTime();
    const monday = new Date(2026, 7, 10, 0, 0, 0).getTime();
    expect(startOfWeek(sunday)).toBe(monday);
    expect(startOfWeek(monday)).toBe(monday);
    expect(startOfWeek(new Date(2026, 7, 10, 13, 30).getTime())).toBe(monday);
  });
});

test("the history horizon is the migration date, stated once", () => {
  expect(MOVEMENT_HISTORY_START).toBe("2026-02-16");
});

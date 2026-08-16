import type { ManagerLease } from "@/lib/api/leases";
import {
  addDays,
  calendarDaysBetween,
  parseDay,
  startOfDay,
} from "@/lib/derived/time";
import { isDeadLease, occupancySnapshot, type UnitFacts } from "@/lib/derived/leasing";

/**
 * OCCUPANCY MOVEMENT — who arrived, who left, and who is booked to do either.
 *
 * This replaced a three-row 30/60/90 projection table. The projection was not
 * wrong so much as unanswerable: it added scheduled move-ins to today's
 * occupancy without asking whether those move-ins were real, and half of them
 * are not.
 *
 * THE CENTRAL CORRECTION. A Cancelled or Denied lease in ResMan still carries
 * a `moveInDate` — the day the applicant WANTED — and a `moveOutDate` for the
 * day the application collapsed. Counted raw, this property shows 382 move-ins
 * and 413 move-outs since the February migration. Counted as tenancies that
 * actually began and ended, it is 197 and 174.
 *
 * The proof is arithmetic rather than judgement: measure moveOut − moveIn per
 * status and Cancelled comes out at a median of MINUS ONE day and Denied at
 * MINUS SEVEN. They left before they arrived. Evicted, Former and Notice to
 * Vacate land at 284, 369 and 364 days with a single negative between them.
 *
 * Everything here is pure and takes `nowMs`, so the whole board is testable
 * without a device or a clock.
 */

// ── what counts as movement ─────────────────────────────────────────────────

/**
 * Lease statuses that mean a real residency ENDED.
 *
 * Deliberately an allow-list rather than "not current". The loose
 * `isEndedStatus` matcher tests for past/evicted/fulfilled and so misses
 * "Former" entirely, which is 57 of this property's departures.
 */
const REAL_EXIT_STATUSES = ["evicted", "former", "notice to vacate"];

/** True when the lease's move-out represents a resident actually leaving. */
export function isRealDeparture(lease: ManagerLease): boolean {
  if (isDeadLease(lease)) return false;
  const s = lease.status.trim().toLowerCase();
  // "Under Eviction" is an eviction in progress — the resident is still here.
  if (s.includes("under eviction")) return false;
  return REAL_EXIT_STATUSES.some((exit) => s === exit || s.includes(exit));
}

/** True when the lease's move-in represents a resident actually arriving. */
export function isRealArrival(lease: ManagerLease): boolean {
  return !isDeadLease(lease);
}

/**
 * The day ResMan's own history begins. Before it, move-outs were never
 * captured: August 2025 shows 31 arrivals and one departure. Any rate measured
 * across this boundary describes the data import, not the property, so every
 * figure on this board starts here.
 */
export const MOVEMENT_HISTORY_START = "2026-02-16";

// ── shapes ──────────────────────────────────────────────────────────────────

export interface MovementBucket {
  /** Local-midnight ms of the bucket start (Monday, or the 1st). */
  startMs: number;
  arrivals: number;
  departures: number;
  net: number;
  /** True when the bucket lies ahead — it holds bookings, not history. */
  scheduled: boolean;
}

export interface CountRow {
  key: string;
  n: number;
}

export interface ExpirationMonth {
  startMs: number;
  leases: number;
  rent: number;
}

export interface ArrivalRow {
  leaseId: string;
  unitNumber: string;
  dateMs: number;
  agent: string;
  rent: number | null;
}

export interface AgentFunnelRow {
  agent: string;
  moved: number;
  denied: number;
  cancelled: number;
  total: number;
  /** 0..1 */
  denialRate: number;
  cancelRate: number;
}

export interface MovementBoard {
  occupancy: { occupied: number; total: number; vacant: number; pct: number };
  /** Inclusive window the rates are measured over. */
  fromMs: number;
  toMs: number;
  arrivals: number;
  departures: number;
  net: number;
  /** Raw counts before dead applications are removed — the correction callout. */
  claimedArrivals: number;
  claimedDepartures: number;
  weeks: MovementBucket[];
  months: MovementBucket[];
  scheduledArrivals: ArrivalRow[];
  scheduledDepartureCount: number;
  /** Live future move-ins per ISO week start. */
  scheduledByWeek: { startMs: number; n: number }[];
  expirations: ExpirationMonth[];
  expiringLeases: number;
  expiringRent: number;
  departureReasons: CountRow[];
  evictionExits: number;
  stayBands: CountRow[];
  medianStayDays: number | null;
  staySample: number;
  funnel: { moved: number; denied: number; cancelled: number; total: number };
  denialReasons: CountRow[];
  cancelReasons: CountRow[];
  /** Cancellations whose reason is blank, "Cancellation" or "Other". */
  vagueCancellations: number;
  medianDaysToDeny: number | null;
  medianDaysToCancel: number | null;
  slowestCancelDays: number | null;
  agentFunnel: AgentFunnelRow[];
  recentArrivals: ArrivalRow[];
  /** Denied units later let to somebody else inside the window. */
  deniedUnitsRelet: number;
  deniedUnits: number;
  deniedRent: number;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Monday-start of the ISO week containing ms. */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function startOfMonthMs(ms: number): number {
  const d = new Date(startOfDay(ms));
  d.setDate(1);
  return d.getTime();
}

function median(sorted: number[]): number | null {
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;
}

function tally(values: string[]): CountRow[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

const rentOf = (l: ManagerLease): number | null => l.residentRent ?? l.marketRent ?? null;
const agentOf = (l: ManagerLease): string => (l.leasingAgent || "").trim();

/** Days lived, or null when either end is missing. Negative means it never happened. */
export function stayLengthDays(lease: ManagerLease): number | null {
  const inMs = parseDay(lease.moveInDate);
  const outMs = parseDay(lease.moveOutDate);
  if (inMs === null || outMs === null) return null;
  return calendarDaysBetween(inMs, outMs);
}

/** Stay bands, widest last. */
const STAY_BANDS: { key: string; max: number }[] = [
  { key: "under6mo", max: 183 },
  { key: "6to12mo", max: 365 },
  { key: "1to2yr", max: 730 },
  { key: "2to5yr", max: 1826 },
  { key: "over5yr", max: Number.POSITIVE_INFINITY },
];

/** A book smaller than this is left off the agent funnel — a rate on three applications says nothing. */
export const MIN_FUNNEL_BOOK = 10;

/** How many recent arrivals the board lists. */
export const RECENT_ARRIVAL_DAYS = 30;

// ── the board ───────────────────────────────────────────────────────────────

export function buildMovementBoard(
  leases: readonly ManagerLease[],
  units: readonly UnitFacts[],
  nowMs: number,
  options: { historyStart?: string } = {},
): MovementBoard {
  const today = startOfDay(nowMs);
  const fromMs = parseDay(options.historyStart ?? MOVEMENT_HISTORY_START) ?? today;
  const inWindow = (ms: number | null): boolean => ms !== null && ms >= fromMs && ms <= today;

  const snap = occupancySnapshot([...units]);
  const occupancy = {
    occupied: snap.occupied,
    total: snap.total,
    vacant: Math.max(0, snap.total - snap.occupied),
    pct: snap.pct,
  };

  // Every lease dated into the window, before and after the correction.
  const claimedIn = leases.filter((l) => inWindow(parseDay(l.moveInDate)));
  const claimedOut = leases.filter((l) => inWindow(parseDay(l.moveOutDate)));
  const arrivals = claimedIn.filter(isRealArrival);
  const departures = claimedOut.filter(isRealDeparture);

  // Booked ahead. Dead applications are excluded here too, or the board would
  // promise arrivals from leases that are already Denied.
  const scheduledArrivalLeases = leases.filter((l) => {
    const ms = parseDay(l.moveInDate);
    return ms !== null && ms > today && isRealArrival(l);
  });
  const scheduledDepartureLeases = leases.filter((l) => {
    const ms = parseDay(l.moveOutDate);
    return ms !== null && ms > today && !isDeadLease(l);
  });

  // ---- weekly and monthly buckets ----
  const bucket = (
    keyOf: (ms: number) => number,
    span: readonly { lease: ManagerLease; ms: number; kind: "in" | "out" }[],
  ): MovementBucket[] => {
    const m = new Map<number, MovementBucket>();
    for (const e of span) {
      const startMs = keyOf(e.ms);
      const b = m.get(startMs) ?? { startMs, arrivals: 0, departures: 0, net: 0, scheduled: startMs > today };
      if (e.kind === "in") b.arrivals += 1;
      else b.departures += 1;
      b.net = b.arrivals - b.departures;
      m.set(startMs, b);
    }
    return [...m.values()].sort((a, b) => a.startMs - b.startMs);
  };

  const historic = [
    ...arrivals.map((lease) => ({ lease, ms: parseDay(lease.moveInDate)!, kind: "in" as const })),
    ...departures.map((lease) => ({ lease, ms: parseDay(lease.moveOutDate)!, kind: "out" as const })),
  ];
  const booked = [
    ...scheduledArrivalLeases.map((lease) => ({ lease, ms: parseDay(lease.moveInDate)!, kind: "in" as const })),
    ...scheduledDepartureLeases.map((lease) => ({ lease, ms: parseDay(lease.moveOutDate)!, kind: "out" as const })),
  ];
  const weeks = bucket(startOfWeek, [...historic, ...booked]);
  // Months stay historic-only: a part-month of bookings next to full months of
  // history reads as a collapse in movement rather than an absence of data.
  const months = bucket(startOfMonthMs, historic);

  // ---- expirations ahead ----
  const expMap = new Map<number, ExpirationMonth>();
  for (const l of leases) {
    if (!l.isCurrentLease) continue;
    const endMs = parseDay(l.endDate);
    if (endMs === null || endMs < today) continue;
    const startMs = startOfMonthMs(endMs);
    const e = expMap.get(startMs) ?? { startMs, leases: 0, rent: 0 };
    e.leases += 1;
    e.rent += rentOf(l) ?? 0;
    expMap.set(startMs, e);
  }
  const expirations = [...expMap.values()].sort((a, b) => a.startMs - b.startMs);

  // ---- why they left, how long they stayed ----
  const departureReasons = tally(departures.map((l) => (l.reasonForLeaving || "").trim() || "notRecorded"));
  const evictionExits = departures.filter((l) => /evict|skipped/i.test(l.reasonForLeaving ?? "")).length;
  const stays = departures
    .map(stayLengthDays)
    .filter((d): d is number => d !== null && d >= 0)
    .sort((a, b) => a - b);
  const stayBands: CountRow[] = STAY_BANDS.map((band, i) => {
    const min = i === 0 ? 0 : STAY_BANDS[i - 1].max;
    return { key: band.key, n: stays.filter((d) => d >= min && d < band.max).length };
  });

  // ---- the application funnel ----
  const denied = claimedOut.filter((l) => /denied/i.test(l.status));
  const cancelled = claimedOut.filter((l) => /cancel/i.test(l.status));
  const funnelTotal = arrivals.length + denied.length + cancelled.length;

  const decisionLag = (l: ManagerLease): number | null => {
    const appMs = parseDay(l.applicationDate);
    const endMs = parseDay(l.moveOutDate);
    if (appMs === null || endMs === null) return null;
    const d = calendarDaysBetween(appMs, endMs);
    return d >= 0 ? d : null;
  };
  const denyLags = denied.map(decisionLag).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const cancelLags = cancelled.map(decisionLag).filter((d): d is number => d !== null).sort((a, b) => a - b);

  const agentMap = new Map<string, AgentFunnelRow>();
  const bumpAgent = (l: ManagerLease, field: "moved" | "denied" | "cancelled") => {
    const agent = agentOf(l) || "unattributed";
    const row = agentMap.get(agent) ??
      { agent, moved: 0, denied: 0, cancelled: 0, total: 0, denialRate: 0, cancelRate: 0 };
    row[field] += 1;
    row.total += 1;
    agentMap.set(agent, row);
  };
  for (const l of arrivals) bumpAgent(l, "moved");
  for (const l of denied) bumpAgent(l, "denied");
  for (const l of cancelled) bumpAgent(l, "cancelled");
  const agentFunnel = [...agentMap.values()]
    .filter((r) => r.total >= MIN_FUNNEL_BOOK)
    .map((r) => ({ ...r, denialRate: r.denied / r.total, cancelRate: r.cancelled / r.total }))
    .sort((a, b) => b.total - a.total);

  // A denial only costs rent if nobody else took the unit.
  const filledUnits = new Set(arrivals.map((l) => l.unitNumber));
  const deniedUnitSet = new Set(denied.map((l) => l.unitNumber).filter(Boolean));
  const deniedUnitsRelet = [...deniedUnitSet].filter((u) => filledUnits.has(u)).length;

  const arrivalRow = (l: ManagerLease, dateKey: "moveInDate" | "moveOutDate"): ArrivalRow => ({
    leaseId: l.id,
    unitNumber: l.unitNumber,
    dateMs: parseDay(l[dateKey])!,
    agent: agentOf(l),
    rent: rentOf(l),
  });

  const recentFrom = addDays(today, -RECENT_ARRIVAL_DAYS);
  const recentArrivals = arrivals
    .filter((l) => parseDay(l.moveInDate)! >= recentFrom)
    .map((l) => arrivalRow(l, "moveInDate"))
    .sort((a, b) => b.dateMs - a.dateMs);

  const byWeek = new Map<number, number>();
  for (const l of scheduledArrivalLeases) {
    const w = startOfWeek(parseDay(l.moveInDate)!);
    byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
  }

  return {
    occupancy,
    fromMs,
    toMs: today,
    arrivals: arrivals.length,
    departures: departures.length,
    net: arrivals.length - departures.length,
    claimedArrivals: claimedIn.length,
    claimedDepartures: claimedOut.length,
    weeks,
    months,
    scheduledArrivals: scheduledArrivalLeases
      .map((l) => arrivalRow(l, "moveInDate"))
      .sort((a, b) => a.dateMs - b.dateMs),
    scheduledDepartureCount: scheduledDepartureLeases.length,
    scheduledByWeek: [...byWeek.entries()]
      .map(([startMs, n]) => ({ startMs, n }))
      .sort((a, b) => a.startMs - b.startMs),
    expirations,
    expiringLeases: expirations.reduce((a, e) => a + e.leases, 0),
    expiringRent: expirations.reduce((a, e) => a + e.rent, 0),
    departureReasons,
    evictionExits,
    stayBands,
    medianStayDays: median(stays),
    staySample: stays.length,
    funnel: { moved: arrivals.length, denied: denied.length, cancelled: cancelled.length, total: funnelTotal },
    denialReasons: tally(denied.map((l) => (l.reasonForLeaving || "").trim() || "notRecorded")),
    cancelReasons: tally(cancelled.map((l) => (l.reasonForLeaving || "").trim() || "notRecorded")),
    vagueCancellations: cancelled.filter((l) => {
      const r = (l.reasonForLeaving || "").trim();
      return r === "" || /^(cancellation|other)$/i.test(r);
    }).length,
    medianDaysToDeny: median(denyLags),
    medianDaysToCancel: median(cancelLags),
    slowestCancelDays: cancelLags.length > 0 ? cancelLags[cancelLags.length - 1] : null,
    agentFunnel,
    recentArrivals,
    deniedUnitsRelet,
    deniedUnits: deniedUnitSet.size,
    deniedRent: denied.reduce((a, l) => a + (l.marketRent ?? 0), 0),
  };
}

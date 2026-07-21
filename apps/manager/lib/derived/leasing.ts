import type { ManagerLease } from "@/lib/api/leases";
import type { ResmanUnit } from "@/lib/api/units";
import {
  addDays,
  calendarDaysBetween,
  monthStartShift,
  parseDay,
  sameCalendarMonth,
  startOfDay,
} from "@/lib/derived/time";

/**
 * The leasing derived engine — every board on the Leasing tab and the Today
 * feed/KPIs is a pure function in here over the synced lease + unit mirrors.
 * No I/O, no store imports, no JSX: the screens are dumb renderers and all of
 * this is testable with plain fixtures (tests/leasing-derived.test.ts).
 *
 * STATUS MATCHERS: ResMan's lease `status` is a free-form residency string
 * ("Current", "Notice - Unrented", "Under Eviction", "Past", "Denied",
 * "Pending Transfer", …) and `approvalStatus` its application counterpart
 * ("Approved", "Pending", "Screening", "Denied", …). The matchers below are
 * lowercase-substring based ON PURPOSE — the sync mirrors whatever ResMan
 * says, so an unseen variant must degrade to a sensible bucket, never crash
 * or vanish. They are exported (and tested) as the single vocabulary seam.
 */

// ── Status matchers ─────────────────────────────────────────────────────────

/** Denied application / cancelled lease — never shown on any board. */
export function isDeniedStatus(s: string): boolean {
  const sl = s.toLowerCase();
  return sl.includes("denied") || sl.includes("cancel");
}

/** Completed residency: past / evicted / fulfilled (port of the sync's isActiveLease negation). */
export function isEndedStatus(s: string): boolean {
  const sl = s.toLowerCase();
  return sl.includes("past") || sl.includes("evicted") || sl.includes("fulfilled");
}

/**
 * Whole-word current/active residency (port of the sync's isCurrentStatus —
 * avoids matching "Non-Current" or "Currently Evicted").
 */
export function isCurrentStatus(s: string): boolean {
  const sl = s.toLowerCase();
  const word = (w: string) =>
    sl === w || sl.startsWith(`${w} `) || sl.endsWith(` ${w}`) || sl.includes(` ${w} `);
  return word("current") || word("active");
}

/** Application not yet a residency: pending / applicant / future / prospect. */
export function isPipelineStatus(s: string): boolean {
  const sl = s.toLowerCase();
  return (
    sl.includes("pending") || sl.includes("applicant") || sl.includes("application") ||
    sl.includes("future") || sl.includes("prospect")
  );
}

/** Notice given (moving out but still in residence). */
export function isNoticeStatus(s: string): boolean {
  return s.toLowerCase().includes("notice");
}

/** Under eviction (still an active residency — "evicted" is ended, this is not). */
export function isEvictionStatus(s: string): boolean {
  const sl = s.toLowerCase();
  return sl.includes("eviction") || (sl.includes("evict") && !sl.includes("evicted"));
}

/** approvalStatus says approved (and not "not approved"/"disapproved"). */
export function isApprovedApproval(s: string): boolean {
  const sl = s.toLowerCase();
  return sl.includes("approv") && !sl.includes("not approv") && !sl.includes("disapprov") && !sl.includes("denied");
}

/** approvalStatus says the screening/review step is in progress. */
export function isScreeningApproval(s: string): boolean {
  const sl = s.toLowerCase();
  return sl.includes("screen") || sl.includes("review") || sl.includes("process") || sl.includes("verif");
}

/** Either field says a lease document went out ("Lease Sent", "Lease Generated", …). */
export function isLeaseSentSignal(status: string, approvalStatus: string): boolean {
  const sl = `${status} ${approvalStatus}`.toLowerCase();
  return sl.includes("lease sent") || sl.includes("lease generated") || sl.includes("lease out");
}

/** Ready-to-show availability ("Ready", "Available" — but not "Not Ready"). */
export function isReadyAvailability(s: string): boolean {
  const sl = s.toLowerCase();
  return (sl.includes("ready") || sl.includes("available")) && !sl.includes("not ");
}

// ── Unit facts ──────────────────────────────────────────────────────────────

/** The slice of a ResMan unit the leasing boards read, pre-lowered once. */
export interface UnitFacts {
  unitNumber: string;
  tenantNames: string[];
  classification: string;
  marketRent: number | null;
  balance: number | null;
  occupied: boolean;
  vacant: boolean;
  ready: boolean;
  /** Real, occupancy-counting door (not a holding unit / excluded placeholder). */
  countsForOccupancy: boolean;
}

export function unitFactsOf(u: ResmanUnit): UnitFacts {
  const occStatus = (u.occupancy_status ?? "").toLowerCase();
  const occupied = u.occupied === true || occStatus.startsWith("occupied");
  const vacant = !occupied && (u.occupied === false || occStatus.includes("vacant"));
  return {
    unitNumber: u.number,
    tenantNames: u.tenant_names,
    classification: u.classification ?? "",
    marketRent: u.market_rent ?? null,
    balance: u.balance ?? null,
    occupied,
    vacant,
    ready: isReadyAvailability(u.availability ?? ""),
    countsForOccupancy: u.excluded_from_occupancy !== true && u.holding_unit !== true,
  };
}

/** Index by unit number for the lease → tenant/classification join. */
export function unitFactsIndex(units: ResmanUnit[]): Map<string, UnitFacts> {
  const map = new Map<string, UnitFacts>();
  for (const u of units) map.set(u.number, unitFactsOf(u));
  return map;
}

/** Primary display name for a unit's household ("" when unknown). */
export function primaryTenantName(facts: UnitFacts | undefined): string {
  return facts?.tenantNames[0] ?? "";
}

// ── Shared lease predicates ─────────────────────────────────────────────────

/** Denied/cancelled anywhere — excluded from every board. */
export function isDeadLease(lease: ManagerLease): boolean {
  return isDeniedStatus(lease.status) || isDeniedStatus(lease.approvalStatus);
}

/**
 * An active residency as of `nowMs`: the sync's is_current_lease flag OR a
 * current-ish status, not ended, and not moved out already.
 */
export function isActiveResidency(lease: ManagerLease, nowMs: number): boolean {
  if (isDeadLease(lease) || isEndedStatus(lease.status)) return false;
  const outMs = parseDay(lease.moveOutDate);
  if (outMs !== null && outMs <= startOfDay(nowMs)) return false;
  return lease.isCurrentLease || isCurrentStatus(lease.status) ||
    isNoticeStatus(lease.status) || isEvictionStatus(lease.status);
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export type PipelineStage =
  | "application"
  | "screening"
  | "approved"
  | "leaseSent"
  | "signed"
  | "movedIn";

/** Stage order for sorting (later stage first on the board). */
export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  "movedIn", "signed", "leaseSent", "approved", "screening", "application",
];

/** A move-in within this many days (either side of today) is "this week". */
export const PIPELINE_IMMINENT_DAYS = 7;
/** Freshly moved-in leases stay on the board this many days. */
export const PIPELINE_MOVED_IN_KEEP_DAYS = 7;
/** Without an explicit pipeline status, application activity this recent still qualifies. */
export const PIPELINE_ACTIVITY_DAYS = 120;

/**
 * Where a lease sits in the applicant funnel, or null when it isn't pipeline
 * material (denied, ended, or a long-settled residency). Defensive on
 * purpose: unknown approval vocab lands on "application", signed/moved-in are
 * detected from their DATES (which the sync fills reliably) before any string.
 */
export function pipelineStageOf(lease: ManagerLease, nowMs: number): PipelineStage | null {
  if (isDeadLease(lease) || isEndedStatus(lease.status)) return null;

  const today = startOfDay(nowMs);
  const inMs = parseDay(lease.moveInDate);
  const outMs = parseDay(lease.moveOutDate);
  if (outMs !== null && outMs <= today) return null;

  // Already in residence: only the freshly-moved-in linger on the board.
  if (inMs !== null && inMs <= today) {
    return calendarDaysBetween(inMs, today) <= PIPELINE_MOVED_IN_KEEP_DAYS ? "movedIn" : null;
  }

  // Not moved in yet — qualify via status, else via recent application activity.
  const appliedMs = parseDay(lease.applicationDate);
  const signedMs = parseDay(lease.signedDate);
  const recentActivity = (ms: number | null) =>
    ms !== null && ms <= today && calendarDaysBetween(ms, today) <= PIPELINE_ACTIVITY_DAYS;
  const qualifies =
    isPipelineStatus(lease.status) || inMs !== null ||
    recentActivity(signedMs) || recentActivity(appliedMs);
  if (!qualifies) return null;

  if (signedMs !== null) return "signed";
  if (isLeaseSentSignal(lease.status, lease.approvalStatus)) return "leaseSent";
  if (isApprovedApproval(lease.approvalStatus)) return "approved";
  if (isScreeningApproval(lease.approvalStatus)) return "screening";
  return "application";
}

export interface PipelineRow {
  lease: ManagerLease;
  stage: PipelineStage;
  tenantName: string;
  classification: string;
  moveInMs: number | null;
  /** Move-in within ±PIPELINE_IMMINENT_DAYS of today (the top band). */
  imminent: boolean;
}

/** All pipeline rows, imminent move-ins first, then by stage, then by move-in date. */
export function buildPipelineRows(
  leases: ManagerLease[],
  unitsByNumber: Map<string, UnitFacts>,
  nowMs: number,
): PipelineRow[] {
  const today = startOfDay(nowMs);
  const rows: PipelineRow[] = [];
  for (const lease of leases) {
    const stage = pipelineStageOf(lease, nowMs);
    if (stage === null) continue;
    const moveInMs = parseDay(lease.moveInDate) ?? parseDay(lease.startDate);
    rows.push({
      lease,
      stage,
      tenantName: primaryTenantName(unitsByNumber.get(lease.unitNumber)),
      classification: unitsByNumber.get(lease.unitNumber)?.classification ?? "",
      moveInMs,
      imminent:
        moveInMs !== null && Math.abs(calendarDaysBetween(moveInMs, today)) <= PIPELINE_IMMINENT_DAYS,
    });
  }
  rows.sort((a, b) => {
    if (a.imminent !== b.imminent) return a.imminent ? -1 : 1;
    const stageDelta =
      PIPELINE_STAGE_ORDER.indexOf(a.stage) - PIPELINE_STAGE_ORDER.indexOf(b.stage);
    if (stageDelta !== 0) return stageDelta;
    return (a.moveInMs ?? Number.MAX_SAFE_INTEGER) - (b.moveInMs ?? Number.MAX_SAFE_INTEGER);
  });
  return rows;
}

// ── Expirations ─────────────────────────────────────────────────────────────

/** A later lease on the same unit counts as renewal/pre-lease coverage. */
export function hasLaterLease(lease: ManagerLease, all: ManagerLease[]): boolean {
  const startMs = parseDay(lease.startDate);
  return all.some((other) => {
    if (other.id === lease.id || isDeadLease(other)) return false;
    const sameUnit =
      (lease.unitId && other.unitId && other.unitId === lease.unitId) ||
      (lease.unitNumber !== "" && other.unitNumber === lease.unitNumber);
    if (!sameUnit) return false;
    const otherStart = parseDay(other.startDate);
    if (otherStart === null) return false;
    return startMs === null || otherStart > startMs;
  });
}

export type ExpirationState = "renewed" | "moveOut" | "open";

export interface ExpirationRow {
  lease: ManagerLease;
  tenantName: string;
  endMs: number;
  daysLeft: number;
  /** marketRent − residentRent, null when either side is unknown. */
  markToMarket: number | null;
  state: ExpirationState;
}

/**
 * Active leases expiring within `windowDays`, soonest first. Renewal =
 * a later lease already exists on the unit; move-out = notice given or a
 * scheduled move-out date; everything else is an open renewal conversation.
 */
export function buildExpirationRows(
  leases: ManagerLease[],
  unitsByNumber: Map<string, UnitFacts>,
  nowMs: number,
  windowDays = 90,
): ExpirationRow[] {
  const today = startOfDay(nowMs);
  const rows: ExpirationRow[] = [];
  for (const lease of leases) {
    if (!isActiveResidency(lease, nowMs)) continue;
    const endMs = parseDay(lease.endDate);
    if (endMs === null) continue;
    const daysLeft = calendarDaysBetween(today, endMs);
    if (daysLeft < 0 || daysLeft > windowDays) continue;
    const market = lease.marketRent ?? null;
    const rent = lease.residentRent ?? null;
    rows.push({
      lease,
      tenantName: primaryTenantName(unitsByNumber.get(lease.unitNumber)),
      endMs,
      daysLeft,
      markToMarket: market !== null && rent !== null ? market - rent : null,
      state: hasLaterLease(lease, leases)
        ? "renewed"
        : isNoticeStatus(lease.status) || parseDay(lease.moveOutDate) !== null
          ? "moveOut"
          : "open",
    });
  }
  rows.sort((a, b) => a.endMs - b.endMs);
  return rows;
}

/** Month buckets (starting the current month) of active-lease expirations. */
export function expiringByMonth(
  leases: ManagerLease[],
  nowMs: number,
  months = 12,
): { monthMs: number; count: number }[] {
  const buckets = Array.from({ length: months }, (_, i) => ({
    monthMs: monthStartShift(nowMs, i),
    count: 0,
  }));
  for (const lease of leases) {
    if (!isActiveResidency(lease, nowMs)) continue;
    const endMs = parseDay(lease.endDate);
    if (endMs === null || endMs < startOfDay(nowMs)) continue;
    const bucket = buckets.find((b) => sameCalendarMonth(b.monthMs, endMs));
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

// ── Occupancy forecast ──────────────────────────────────────────────────────

export interface OccupancySnapshot {
  occupied: number;
  total: number;
  /** 0–100, one decimal's worth of precision left to the formatter. */
  pct: number;
}

export function occupancySnapshot(units: UnitFacts[]): OccupancySnapshot {
  const counted = units.filter((u) => u.countsForOccupancy);
  const occupied = counted.filter((u) => u.occupied).length;
  return {
    occupied,
    total: counted.length,
    pct: counted.length > 0 ? (occupied / counted.length) * 100 : 0,
  };
}

export interface ForecastRow {
  horizonDays: number;
  occupiedNow: number;
  total: number;
  moveIns: number;
  moveOuts: number;
  projectedOccupied: number;
  projectedPct: number;
}

/** Scheduled move-ins strictly inside (now, now + horizon]. */
export function scheduledMoveIns(leases: ManagerLease[], nowMs: number, horizonDays: number): number {
  const today = startOfDay(nowMs);
  const end = addDays(today, horizonDays);
  return leases.filter((lease) => {
    if (isDeadLease(lease) || isEndedStatus(lease.status)) return false;
    const inMs = parseDay(lease.moveInDate) ?? parseDay(lease.startDate);
    return inMs !== null && inMs > today && inMs <= end;
  }).length;
}

/** Scheduled move-outs inside (now, now + horizon] — explicit dates, plus notice leases ending in-window. */
export function scheduledMoveOuts(leases: ManagerLease[], nowMs: number, horizonDays: number): number {
  const today = startOfDay(nowMs);
  const end = addDays(today, horizonDays);
  return leases.filter((lease) => {
    if (isDeadLease(lease) || isEndedStatus(lease.status)) return false;
    const outMs = parseDay(lease.moveOutDate);
    if (outMs !== null) return outMs > today && outMs <= end;
    if (!isNoticeStatus(lease.status)) return false;
    const endMs = parseDay(lease.endDate);
    return endMs !== null && endMs > today && endMs <= end;
  }).length;
}

/** Rolling 30/60/90-day occupancy projection from scheduled ins and outs. */
export function buildForecastRows(
  leases: ManagerLease[],
  units: UnitFacts[],
  nowMs: number,
  horizons: number[] = [30, 60, 90],
): ForecastRow[] {
  const snap = occupancySnapshot(units);
  return horizons.map((horizonDays) => {
    const moveIns = scheduledMoveIns(leases, nowMs, horizonDays);
    const moveOuts = scheduledMoveOuts(leases, nowMs, horizonDays);
    const projectedOccupied = Math.max(
      0,
      Math.min(snap.total, snap.occupied + moveIns - moveOuts),
    );
    return {
      horizonDays,
      occupiedNow: snap.occupied,
      total: snap.total,
      moveIns,
      moveOuts,
      projectedOccupied,
      projectedPct: snap.total > 0 ? (projectedOccupied / snap.total) * 100 : 0,
    };
  });
}

// ── Vacancy exposure ────────────────────────────────────────────────────────

export interface VacancyRow {
  unitNumber: string;
  classification: string;
  marketRent: number | null;
  ready: boolean;
}

/** Vacant, occupancy-counting units — biggest exposure (market rent) first. */
export function buildVacancyRows(units: UnitFacts[]): VacancyRow[] {
  return units
    .filter((u) => u.countsForOccupancy && u.vacant)
    .map((u) => ({
      unitNumber: u.unitNumber,
      classification: u.classification,
      marketRent: u.marketRent,
      ready: u.ready,
    }))
    .sort((a, b) => (b.marketRent ?? 0) - (a.marketRent ?? 0));
}

export interface VacancySummary {
  count: number;
  ready: number;
  /** Sum of the vacant units' market rents — monthly $ walking out the door. */
  exposure: number;
}

export function vacancySummary(rows: VacancyRow[]): VacancySummary {
  return {
    count: rows.length,
    ready: rows.filter((r) => r.ready).length,
    exposure: rows.reduce((sum, r) => sum + (r.marketRent ?? 0), 0),
  };
}

// ── Today feed ──────────────────────────────────────────────────────────────

export type FeedKind = "moveIn" | "application" | "signed" | "moveOut";

export interface FeedEvent {
  /** Stable per-event key (lease id + kind). */
  key: string;
  kind: FeedKind;
  unitNumber: string;
  tenantName: string;
  /** Local-midnight ms of the event day (future for scheduled move-outs). */
  whenMs: number;
  /** Rent context where it reads naturally (move-in, signed). */
  rent: number | null;
  /** For moveOut: the effective date is in the future (scheduled, not happened). */
  scheduled: boolean;
}

export const FEED_LOOKBACK_DAYS = 14;
export const FEED_MOVEOUT_AHEAD_DAYS = 60;
export const FEED_CAP = 30;

/**
 * The Today flow: recent lease-lifecycle events derived purely from dates —
 * moved in / application received / signed within the lookback, plus notice
 * and scheduled move-outs up to 60 days out. Newest first, capped.
 */
export function buildTodayFeed(
  leases: ManagerLease[],
  unitsByNumber: Map<string, UnitFacts>,
  nowMs: number,
  opts: { lookbackDays?: number; aheadDays?: number; cap?: number } = {},
): FeedEvent[] {
  const lookback = opts.lookbackDays ?? FEED_LOOKBACK_DAYS;
  const ahead = opts.aheadDays ?? FEED_MOVEOUT_AHEAD_DAYS;
  const cap = opts.cap ?? FEED_CAP;
  const today = startOfDay(nowMs);
  const floor = addDays(today, -lookback);
  const ceiling = addDays(today, ahead);

  const events: FeedEvent[] = [];
  const push = (lease: ManagerLease, kind: FeedKind, whenMs: number, rent: number | null) => {
    events.push({
      key: `${lease.id}:${kind}`,
      kind,
      unitNumber: lease.unitNumber,
      tenantName: primaryTenantName(unitsByNumber.get(lease.unitNumber)),
      whenMs,
      rent,
      scheduled: kind === "moveOut" && whenMs > today,
    });
  };

  for (const lease of leases) {
    if (isDeadLease(lease)) continue;
    const rent = lease.residentRent ?? lease.marketRent ?? null;

    const inMs = parseDay(lease.moveInDate);
    if (inMs !== null && inMs >= floor && inMs <= today) push(lease, "moveIn", inMs, rent);

    const appliedMs = parseDay(lease.applicationDate);
    if (appliedMs !== null && appliedMs >= floor && appliedMs <= today) {
      push(lease, "application", appliedMs, null);
    }

    const signedMs = parseDay(lease.signedDate);
    if (signedMs !== null && signedMs >= floor && signedMs <= today) push(lease, "signed", signedMs, rent);

    const outMs = parseDay(lease.moveOutDate);
    if (outMs !== null && outMs >= floor && outMs <= ceiling) push(lease, "moveOut", outMs, null);
  }

  events.sort((a, b) => b.whenMs - a.whenMs);
  return events.slice(0, cap);
}

// ── Formatting + score cards ────────────────────────────────────────────────

/** "$48.2k" over a thousand, "$590" under, "—" for null. */
export function shortMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) {
    const k = abs / 1000;
    return `${sign}$${k >= 100 ? Math.round(k).toLocaleString() : k.toFixed(1)}k`;
  }
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

/** "92.4%" — one decimal, clamped sensibly. */
export function shortPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/** Signed mark-to-market: "+$95" / "-$40" / "$0". */
export function signedMoney(n: number): string {
  const body = `$${Math.abs(Math.round(n)).toLocaleString()}`;
  return n > 0 ? `+${body}` : n < 0 ? `-${body}` : body;
}

/**
 * A score-strip cell: value preformatted here, label/caption as i18n keys the
 * screen resolves (the engine stays locale-free and testable).
 */
export interface ScoreMetric {
  key: string;
  value: string;
  tint?: string;
  labelKey: string;
  captionKey?: string;
  captionParams?: Record<string, string | number>;
}

const TINT = {
  green: "#33A666",
  red: "#D1382E",
  blue: "#2563B4",
  amber: "#B05E14",
  olive: "#767B24",
} as const;

export type LeasingMode = "pipeline" | "expirations" | "forecast" | "vacancy";

/** Signed within this window counts toward the "signed this cycle" average. */
export const SIGNED_CYCLE_DAYS = 90;

/** The three header metrics for a Leasing mode. */
export function buildLeasingMetrics(input: {
  mode: LeasingMode;
  pipelineRows: PipelineRow[];
  expirationRows90: ExpirationRow[];
  forecastRows: ForecastRow[];
  vacancyRows: VacancyRow[];
  leases: ManagerLease[];
  nowMs: number;
}): ScoreMetric[] {
  const { mode, nowMs } = input;
  const today = startOfDay(nowMs);

  switch (mode) {
    case "pipeline": {
      const rows = input.pipelineRows;
      const approved = rows.filter((r) => r.stage === "approved").length;
      const screening = rows.filter((r) => r.stage === "screening").length;
      const moveIns30 = scheduledMoveIns(input.leases, nowMs, 30);
      const signedRents = input.leases
        .filter((lease) => {
          if (isDeadLease(lease)) return false;
          const signedMs = parseDay(lease.signedDate);
          return (
            signedMs !== null && signedMs <= today &&
            calendarDaysBetween(signedMs, today) <= SIGNED_CYCLE_DAYS &&
            lease.residentRent !== null && lease.residentRent !== undefined
          );
        })
        .map((lease) => lease.residentRent as number);
      const avgRent =
        signedRents.length > 0
          ? signedRents.reduce((a, b) => a + b, 0) / signedRents.length
          : null;
      return [
        {
          key: "applicants", value: String(rows.length), tint: TINT.blue,
          labelKey: "leasing.metrics.applicants",
          captionKey: "leasing.metrics.applicantsCaption",
          captionParams: { approved, screening },
        },
        {
          key: "moveIns30", value: String(moveIns30), tint: TINT.olive,
          labelKey: "leasing.metrics.moveIns30",
          captionKey: "leasing.metrics.moveIns30Caption",
        },
        {
          key: "avgRent",
          value: avgRent !== null ? `$${Math.round(avgRent).toLocaleString()}` : "—",
          tint: TINT.green,
          labelKey: "leasing.metrics.avgLeaseRent",
          captionKey: "leasing.metrics.avgLeaseRentCaption",
        },
      ];
    }
    case "expirations": {
      const rows = input.expirationRows90;
      const in30 = rows.filter((r) => r.daysLeft <= 30);
      const in60 = rows.filter((r) => r.daysLeft > 30 && r.daysLeft <= 60);
      const renewed = rows.filter((r) => r.state === "renewed").length;
      const awaiting = rows.filter((r) => r.state === "open").length;
      const atRisk = (subset: ExpirationRow[]) =>
        subset
          .filter((r) => r.state !== "renewed")
          .reduce((sum, r) => sum + (r.lease.residentRent ?? 0), 0);
      return [
        {
          key: "next30", value: String(in30.length), tint: TINT.red,
          labelKey: "leasing.metrics.next30",
          captionKey: "leasing.metrics.rentAtRisk",
          captionParams: { amount: shortMoney(atRisk(in30)) },
        },
        {
          key: "days3160", value: String(in60.length), tint: TINT.amber,
          labelKey: "leasing.metrics.days3160",
          captionKey: "leasing.metrics.rentAtRisk",
          captionParams: { amount: shortMoney(atRisk(in60)) },
        },
        {
          key: "renewed", value: String(renewed), tint: TINT.green,
          labelKey: "leasing.metrics.renewed",
          captionKey: "leasing.metrics.renewedCaption",
          captionParams: { awaiting },
        },
      ];
    }
    case "forecast": {
      const [f30, , f90] = [
        input.forecastRows.find((r) => r.horizonDays === 30),
        input.forecastRows.find((r) => r.horizonDays === 60),
        input.forecastRows.find((r) => r.horizonDays === 90),
      ];
      const snapPct = input.forecastRows[0]
        ? (input.forecastRows[0].occupiedNow / Math.max(input.forecastRows[0].total, 1)) * 100
        : 0;
      return [
        {
          key: "occupancyNow", value: shortPct(snapPct), tint: TINT.green,
          labelKey: "leasing.metrics.occupancyNow",
          captionKey: "leasing.metrics.occupancyNowCaption",
          captionParams: {
            occupied: input.forecastRows[0]?.occupiedNow ?? 0,
            total: input.forecastRows[0]?.total ?? 0,
          },
        },
        {
          key: "projected30", value: f30 ? shortPct(f30.projectedPct) : "—", tint: TINT.blue,
          labelKey: "leasing.metrics.projected30",
          captionKey: "leasing.metrics.projectedCaption",
          captionParams: { ins: f30?.moveIns ?? 0, outs: f30?.moveOuts ?? 0 },
        },
        {
          key: "projected90", value: f90 ? shortPct(f90.projectedPct) : "—", tint: TINT.amber,
          labelKey: "leasing.metrics.projected90",
          captionKey: "leasing.metrics.projectedCaption",
          captionParams: { ins: f90?.moveIns ?? 0, outs: f90?.moveOuts ?? 0 },
        },
      ];
    }
    case "vacancy": {
      const summary = vacancySummary(input.vacancyRows);
      return [
        {
          key: "vacant", value: String(summary.count), tint: TINT.red,
          labelKey: "leasing.metrics.vacant",
          captionKey: "leasing.metrics.vacantCaption",
        },
        {
          key: "ready", value: String(summary.ready), tint: TINT.green,
          labelKey: "leasing.metrics.ready",
          captionKey: "leasing.metrics.readyCaption",
        },
        {
          key: "exposure", value: shortMoney(summary.exposure), tint: TINT.amber,
          labelKey: "leasing.metrics.exposure",
          captionKey: "leasing.metrics.exposureCaption",
        },
      ];
    }
  }
}

/** The Today header strip: occupancy · balances owed · move-ins 30d · expiring 60d. */
export function buildTodayMetrics(input: {
  units: UnitFacts[];
  leases: ManagerLease[];
  expirationRows90: ExpirationRow[];
  nowMs: number;
}): ScoreMetric[] {
  const snap = occupancySnapshot(input.units);
  const owing = input.units.filter((u) => (u.balance ?? 0) > 0);
  const owed = owing.reduce((sum, u) => sum + (u.balance ?? 0), 0);
  const moveIns30 = scheduledMoveIns(input.leases, input.nowMs, 30);
  const expiring60 = input.expirationRows90.filter((r) => r.daysLeft <= 60);
  const atRisk60 = expiring60
    .filter((r) => r.state !== "renewed")
    .reduce((sum, r) => sum + (r.lease.residentRent ?? 0), 0);
  return [
    {
      key: "occupancy", value: shortPct(snap.pct), tint: TINT.green,
      labelKey: "today.metrics.occupancy",
      captionKey: "today.metrics.occupancyCaption",
      captionParams: { occupied: snap.occupied, total: snap.total },
    },
    {
      key: "balances", value: shortMoney(owed), tint: TINT.red,
      labelKey: "today.metrics.balances",
      captionKey: "today.metrics.balancesCaption",
      captionParams: { count: owing.length },
    },
    {
      key: "moveIns30", value: String(moveIns30), tint: TINT.blue,
      labelKey: "today.metrics.moveIns30",
    },
    {
      key: "expiring60", value: String(expiring60.length), tint: TINT.amber,
      labelKey: "today.metrics.expiring60",
      captionKey: "today.metrics.expiring60Caption",
      captionParams: { amount: shortMoney(atRisk60) },
    },
  ];
}

// ── Move-in / move-out monthly flow (Today chart) ───────────────────────────

export interface MonthlyFlow {
  monthMs: number;
  moveIns: number;
  moveOuts: number;
}

/** Last `months` calendar months (oldest first) of realized move-ins/outs. */
export function buildMonthlyFlow(
  leases: ManagerLease[],
  nowMs: number,
  months = 6,
): MonthlyFlow[] {
  const buckets: MonthlyFlow[] = Array.from({ length: months }, (_, i) => ({
    monthMs: monthStartShift(nowMs, i - (months - 1)),
    moveIns: 0,
    moveOuts: 0,
  }));
  for (const lease of leases) {
    if (isDeadLease(lease)) continue;
    const inMs = parseDay(lease.moveInDate);
    if (inMs !== null) {
      const b = buckets.find((x) => sameCalendarMonth(x.monthMs, inMs));
      if (b) b.moveIns += 1;
    }
    const outMs = parseDay(lease.moveOutDate);
    if (outMs !== null && outMs <= startOfDay(nowMs)) {
      const b = buckets.find((x) => sameCalendarMonth(x.monthMs, outMs));
      if (b) b.moveOuts += 1;
    }
  }
  return buckets;
}

import type { LegendItem } from "./map-color";

/**
 * Delinquency math for the manager app: aging buckets, the balance heat ramp
 * painted onto the shared Skia map, tenant P&L verdicts, and the collections
 * work-queue priority score. Pure functions over synced ResMan-derived
 * numbers — no I/O, no framework imports.
 */

export const AGING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/**
 * How long the resident has lived here, in bands.
 *
 * Distinct from AGING_BUCKETS, which measure how old the DEBT is. Tenure
 * measures how long the TENANCY is, and the two answer different questions: a
 * 90+ balance on someone three weeks in is a screening problem, the same
 * balance on a five-year resident is a life-event problem, and they call for
 * different conversations.
 *
 * The bands are tight early because that is where risk moves fastest — across
 * the property, delinquency runs 28% in the first six months, peaks at 41%
 * between six and twelve, then settles near 29% and falls to 20% past five
 * years.
 */
export const TENURE_BUCKETS = ["0-30", "31-60", "61-90", "91-120", "121-180", "181-365", "1yr+"] as const;
export type TenureBucket = (typeof TENURE_BUCKETS)[number];

/**
 * Days lived here → band. Negative days (a move-in dated in the future, which
 * ResMan does carry on approved-but-not-arrived leases) fold into the first
 * band rather than falling out of the grouping entirely.
 */
export function tenureBucket(daysSinceMoveIn: number): TenureBucket {
  if (daysSinceMoveIn <= 30) return "0-30";
  if (daysSinceMoveIn <= 60) return "31-60";
  if (daysSinceMoveIn <= 90) return "61-90";
  if (daysSinceMoveIn <= 120) return "91-120";
  if (daysSinceMoveIn <= 180) return "121-180";
  if (daysSinceMoveIn <= 365) return "181-365";
  return "1yr+";
}

/**
 * Whole days from a "YYYY-MM-DD" move-in to `nowMs`, or null when unparseable.
 * Parsed as LOCAL midnight — UTC parsing shifts the date back a day and can
 * push a same-day move-in into the wrong band.
 */
export function daysSinceMoveIn(moveInDate: string | null | undefined, nowMs: number): number | null {
  if (!moveInDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(moveInDate.trim());
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (Number.isNaN(start)) return null;
  return Math.floor((nowMs - start) / 86_400_000);
}

/**
 * The aging columns as synced from ResMan's delinquency report:
 * current month = 0-30 days, last month = 31-60, period = 61-90,
 * previous = 90+. `balance` is the total owed when the report carries it.
 */
export interface AgingColumns {
  /** Owed 0-30 days. */
  currentMonthBalance?: number | null;
  /** Owed 31-60 days. */
  lastMonthBalance?: number | null;
  /** Owed 61-90 days. */
  periodBalance?: number | null;
  /** Owed 90+ days. */
  previousBalance?: number | null;
  /** Total balance; when absent it is derived as the sum of the columns. */
  balance?: number | null;
}

/**
 * The OLDEST aging bucket with money in it, or null when the total balance is
 * <= 0 (credit or current). When the total is positive but no individual
 * column is (e.g. the aging columns weren't synced), falls back to "0-30" —
 * a positive balance is at minimum current-month debt.
 */
export function agingBucket(unit: AgingColumns): AgingBucket | null {
  const num = (v: number | null | undefined) => (typeof v === "number" ? v : 0);
  const current = num(unit.currentMonthBalance);
  const last = num(unit.lastMonthBalance);
  const period = num(unit.periodBalance);
  const previous = num(unit.previousBalance);
  const total = typeof unit.balance === "number" ? unit.balance : current + last + period + previous;
  if (total <= 0) return null;
  if (previous > 0) return "90+";
  if (period > 0) return "61-90";
  if (last > 0) return "31-60";
  return "0-30";
}

/** Deep red painted over any unit flagged for eviction, regardless of balance. */
export const EVICTION_HEAT_COLOR = "#7A1F1F";

/**
 * 5-step balance heat ramp for the delinquency map mode. Bands are
 * exclusive-min / inclusive-max: <=0, (0,300], (300,800], (800,1500], >1500.
 * An eviction flag overrides the ramp with EVICTION_HEAT_COLOR.
 */
export function balanceHeatColor(balance: number, eviction: boolean): string {
  if (eviction) return EVICTION_HEAT_COLOR;
  if (balance <= 0) return "#FFFFFF";
  if (balance <= 300) return "#F8E7C8";
  if (balance <= 800) return "#F3C08B";
  if (balance <= 1500) return "#E88A5E";
  return "#D1382E";
}

/** Legend entries for the delinquency heat map, in ramp order (eviction last). */
export const BALANCE_HEAT_LEGEND: LegendItem[] = [
  { label: "Current", color: "#FFFFFF" },
  { label: "≤ $300", color: "#F8E7C8" },
  { label: "≤ $800", color: "#F3C08B" },
  { label: "≤ $1,500", color: "#E88A5E" },
  { label: "> $1,500", color: "#D1382E" },
  { label: "Eviction", color: EVICTION_HEAT_COLOR },
];

/** Inputs to a tenant's net position, all in dollars (costs as positive numbers). */
export interface NetPositionInput {
  collected: number;
  concessions: number;
  badDebt: number;
  legal: number;
  utilityExposure: number;
  maintenanceEstimate: number;
}

/** Net dollars the tenancy produced: collected minus every cost bucket. */
export function netPosition(input: NetPositionInput): number {
  return (
    input.collected -
    input.concessions -
    input.badDebt -
    input.legal -
    input.utilityExposure -
    input.maintenanceEstimate
  );
}

/**
 * A non-loss lease is still "marginal" when it nets less than this many
 * dollars per occupied month — a thin lease that barely covers itself.
 */
export const MARGINAL_PER_MONTH = 150;

export type LeaseVerdict = "profitable" | "marginal" | "loss";

/**
 * loss when net < 0; marginal when net >= 0 but net per occupied month is
 * under MARGINAL_PER_MONTH; else profitable. monthsOccupied is clamped to a
 * minimum of 1 so a fresh lease doesn't divide by zero.
 */
export function verdictFor(net: number, monthsOccupied: number): LeaseVerdict {
  if (net < 0) return "loss";
  const months = Math.max(1, monthsOccupied);
  return net / months < MARGINAL_PER_MONTH ? "marginal" : "profitable";
}

export interface DelinquencyPriorityInput {
  balance: number;
  agingBucket: AgingBucket | null;
  timesLate: number;
  brokenPromise?: boolean;
}

const AGE_WEIGHT: Record<AgingBucket, number> = { "0-30": 1, "31-60": 2, "61-90": 3, "90+": 4 };

/**
 * Sortable collections priority (higher = work first):
 *
 *   ageWeight * 1000 + clamp(balance, 0, 5000) / 10 + timesLate * 50 + (brokenPromise ? 500 : 0)
 *
 * where ageWeight is 0-30=1, 31-60=2, 61-90=3, 90+=4 (0 when no bucket).
 * Age dominates (each bucket step outranks any balance), balance is capped at
 * $5,000 so one huge balance can't outrank older debt, each recorded late
 * month adds 50, and a broken payment promise adds a flat 500 — half a bucket.
 */
export function delinquencyPriority(u: DelinquencyPriorityInput): number {
  const age = u.agingBucket ? AGE_WEIGHT[u.agingBucket] : 0;
  const cappedBalance = Math.min(Math.max(u.balance, 0), 5000);
  return age * 1000 + cappedBalance / 10 + u.timesLate * 50 + (u.brokenPromise ? 500 : 0);
}

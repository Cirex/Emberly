import type { Snapshot } from "@/lib/api/snapshots";

/**
 * Pure derivations over the daily property_snapshots window for the Trends
 * sheet and the Today sparklines. No I/O, no React — everything is testable
 * math over the store's oldest-first snapshot array.
 *
 * NULL DISCIPLINE (the "honest backfill" rule): a null metric means the
 * series had not begun on that day. Series helpers skip nulls, the
 * series-began helper reports the first real day, and the compare helpers
 * answer null instead of inventing a number.
 */

// ── Ranges ──────────────────────────────────────────────────────────────────

export type TrendRange = "12m" | "3m" | "30d";
export const TREND_RANGES: TrendRange[] = ["12m", "3m", "30d"];

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" (UTC) for an epoch ms. Snapshot dates are plain calendar
 *  days, so all window math here stays in UTC day space. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" `months` calendar months before `nowMs`. */
function monthsAgoIso(nowMs: number, months: number): string {
  const now = new Date(nowMs);
  return isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
}

/** Inclusive window floor for a range chip. */
export function rangeStartIso(nowMs: number, range: TrendRange): string {
  if (range === "12m") return monthsAgoIso(nowMs, 12);
  if (range === "3m") return monthsAgoIso(nowMs, 3);
  return isoOf(nowMs - 30 * DAY_MS);
}

/** The snapshots inside a range chip's window (input is oldest-first). */
export function sliceRange(
  snapshots: Snapshot[],
  range: TrendRange,
  nowMs: number,
): Snapshot[] {
  const floor = rangeStartIso(nowMs, range);
  return snapshots.filter((s) => s.date >= floor);
}

// ── Series ──────────────────────────────────────────────────────────────────

/** Reads one metric off a snapshot ("occupancyPct", "balanceTotal", …). */
export type MetricPick = (s: Snapshot) => number | null;

export interface TrendPoint {
  date: string;
  value: number;
}

/** The non-null points of one metric, oldest first — the drawable series. */
export function seriesOf(snapshots: Snapshot[], pick: MetricPick): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (const s of snapshots) {
    const value = pick(s);
    if (value !== null) points.push({ date: s.date, value });
  }
  return points;
}

/** The first day a metric has a real value — the honest "series began" date —
 *  or null when the series hasn't begun at all. */
export function seriesBeganDate(snapshots: Snapshot[], pick: MetricPick): string | null {
  for (const s of snapshots) {
    if (pick(s) !== null) return s.date;
  }
  return null;
}

/** Last-minus-first change across the drawn window, with the latest value. */
export function rangeDelta(points: TrendPoint[]): { last: number; delta: number } | null {
  if (points.length === 0) return null;
  return {
    last: points[points.length - 1].value,
    delta: points[points.length - 1].value - points[0].value,
  };
}

/**
 * Year-over-year delta for a metric: the latest value minus the value one
 * year earlier (the snapshot nearest that target day, within a ±15-day
 * tolerance so a sparse backfill still answers). Null until a year of
 * history exists.
 */
export function yoyDelta(snapshots: Snapshot[], pick: MetricPick): number | null {
  const points = seriesOf(snapshots, pick);
  if (points.length === 0) return null;
  const last = points[points.length - 1];
  const lastMs = Date.parse(last.date);
  const targetMs = lastMs - 365 * DAY_MS;
  let nearest: TrendPoint | null = null;
  let nearestGap = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const gap = Math.abs(Date.parse(p.date) - targetMs);
    if (gap < nearestGap) {
      nearest = p;
      nearestGap = gap;
    }
  }
  if (!nearest || nearestGap > 15 * DAY_MS) return null;
  return last.value - nearest.value;
}

// ── Sparklines (Today KPI strip) ────────────────────────────────────────────

/** Mockup rule: "Sparklines appear once 14 days of snapshots exist". */
export const MIN_SPARK_POINTS = 14;

/**
 * The last 30 days of a metric as raw values for a Spark, or null while fewer
 * than MIN_SPARK_POINTS daily points exist — the gate that keeps a two-day-old
 * table from drawing a meaningless squiggle.
 */
export function sparkValues(
  snapshots: Snapshot[],
  pick: MetricPick,
  nowMs: number,
): number[] | null {
  const floor = isoOf(nowMs - 30 * DAY_MS);
  const values = seriesOf(
    snapshots.filter((s) => s.date >= floor),
    pick,
  ).map((p) => p.value);
  return values.length >= MIN_SPARK_POINTS ? values : null;
}

// ── This month vs last ──────────────────────────────────────────────────────

export interface CompareRow {
  current: number;
  previous: number;
  delta: number;
  /** Whether a POSITIVE delta is good news (tints the ▲/▼). */
  upIsGood: boolean;
}

/** "YYYY-MM" of a snapshot date / an epoch ms. */
function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/** The latest snapshot in `month` with a non-null pick, or null. */
function monthClose(snapshots: Snapshot[], month: string, pick: MetricPick): number | null {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (monthKeyOf(s.date) !== month) continue;
    const value = pick(s);
    if (value !== null) return value;
  }
  return null;
}

function compareMonths(
  snapshots: Snapshot[],
  nowMs: number,
  pick: MetricPick,
  upIsGood: boolean,
): CompareRow | null {
  const now = new Date(nowMs);
  const thisMonth = isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).slice(0, 7);
  const lastMonth = isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).slice(0, 7);
  const current = monthClose(snapshots, thisMonth, pick);
  const previous = monthClose(snapshots, lastMonth, pick);
  if (current === null || previous === null) return null;
  return { current, previous, delta: current - previous, upIsGood };
}

/**
 * Collections-rate PROXY from snapshots: 1 − (0-30-day balance ÷ rent roll)
 * as a percentage — how much of the current month's roll is NOT sitting in
 * the freshest aging bucket. The snapshot table carries no billed/collected
 * ledger, so this is the honest derivable stand-in; it tracks the real rate's
 * direction, which is what a vs-last-month row needs.
 */
export function collectionsRatePct(s: Snapshot): number | null {
  if (s.balance0To30 === null || s.rentRoll === null || s.rentRoll <= 0) return null;
  return Math.round((1 - s.balance0To30 / s.rentRoll) * 1000) / 10;
}

export interface MonthCompare {
  /** Collections-rate proxy, percentage points. Null until two months exist. */
  collections: CompareRow | null;
  /** Delinquent-unit count. Null until two months exist. */
  delinquentUnits: CompareRow | null;
  // NOTE: the mockup's "avg days vacant" row is omitted on purpose — days
  // vacant needs per-unit vacancy spells (move-outs vs move-ins), which the
  // one-row-per-day snapshot table cannot express. Deriving it here would be
  // a made-up number; the design's honesty rule says omit instead.
}

/** "This month vs last" — each row compares the months' closing snapshots. */
export function buildMonthCompare(snapshots: Snapshot[], nowMs: number): MonthCompare {
  return {
    collections: compareMonths(snapshots, nowMs, collectionsRatePct, true),
    delinquentUnits: compareMonths(snapshots, nowMs, (s) => s.delinquentUnits, false),
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** "$48.2k" / "$1.09M" / "$590" / "—". */
export function trendMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1000) {
    const k = abs / 1000;
    return `${sign}$${k >= 100 ? Math.round(k).toLocaleString() : k.toFixed(1)}k`;
  }
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

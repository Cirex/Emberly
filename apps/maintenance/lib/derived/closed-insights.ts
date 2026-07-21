import { DAY_MS, type ParsedWorkOrder } from "./types";
import { addDays, sameCalendarMonth, startOfWeek } from "./time";
import { isCallbackSignal } from "./filtering";

/**
 * Aggregates for the Closed board's insights sheet (chart chip in the header).
 *
 *   weeks:          reported-vs-closed inflow/outflow, last 6 calendar weeks —
 *                   "is the backlog draining or growing?"
 *   callbackMonths: share of a month's closures that later drew a callback
 *                   signal (a signal ticket's callbackMatchedId points at the
 *                   completed work order) — the quality counterweight to the
 *                   speed metrics.
 *   categoryMix:    where the closed work actually was, last 90 days, top four
 *                   categories + Other.
 *
 * Reported counts come from the full non-make-ready set (an inflow is an
 * inflow whether or not it has closed yet); closed counts come from the
 * closed board's filtered rows so the sheet always agrees with the list.
 */

export interface InsightWeek {
  /** Monday (local) the week starts on. */
  startMs: number;
  reported: number;
  closed: number;
}

export interface CallbackMonth {
  /** First day (local) of the month. */
  startMs: number;
  closed: number;
  callbacks: number;
  /** callbacks / closed, 0 when the month has no closures. */
  rate: number;
}

export interface CategorySlice {
  /** Raw category label ("Plumbing", …) or null for the folded Other slice. */
  category: string | null;
  count: number;
  /** Share of the 90-day closure total, 0..1. */
  fraction: number;
}

export interface ClosedInsights {
  weeks: InsightWeek[];
  callbackMonths: CallbackMonth[];
  categoryMix: CategorySlice[];
  /** Closures in the last 90 days (categoryMix denominator). */
  recentClosedCount: number;
}

const WEEK_COUNT = 6;
const MONTH_COUNT = 3;
const MIX_WINDOW_MS = 90 * DAY_MS;
const MIX_TOP = 4;

export function buildClosedInsights(input: {
  allNonMakeReady: ParsedWorkOrder[];
  closedFiltered: ParsedWorkOrder[];
  nowMs: number;
}): ClosedInsights {
  const { allNonMakeReady, closedFiltered, nowMs } = input;

  // ── Reported vs closed, last 6 weeks ──────────────────────────────────────
  const currentWeekStart = startOfWeek(nowMs);
  const weekStarts: number[] = [];
  for (let i = WEEK_COUNT - 1; i >= 0; i -= 1) {
    weekStarts.push(startOfWeek(addDays(currentWeekStart, -7 * i)));
  }
  const weeks: InsightWeek[] = weekStarts.map((startMs) => ({ startMs, reported: 0, closed: 0 }));
  const windowStart = weekStarts[0];
  const windowEnd = addDays(currentWeekStart, 7);
  const weekIndex = (ms: number): number | null => {
    if (ms < windowStart || ms >= windowEnd) return null;
    const idx = weeks.findLastIndex((w) => ms >= w.startMs);
    return idx >= 0 ? idx : null;
  };
  for (const wo of allNonMakeReady) {
    if (wo.reportedAt !== null) {
      const idx = weekIndex(wo.reportedAt);
      if (idx !== null) weeks[idx].reported += 1;
    }
  }
  for (const wo of closedFiltered) {
    if (wo.completedAt !== null) {
      const idx = weekIndex(wo.completedAt);
      if (idx !== null) weeks[idx].closed += 1;
    }
  }

  // ── Callback rate per month, last 3 calendar months ───────────────────────
  // A signal ticket names the completed work order it calls back on; a closure
  // "drew a callback" when any signal points at it.
  const calledBack = new Set<string>();
  for (const wo of allNonMakeReady) {
    if (isCallbackSignal(wo) && wo.callbackMatchedId) calledBack.add(wo.callbackMatchedId);
  }
  const callbackMonths: CallbackMonth[] = [];
  for (let i = MONTH_COUNT - 1; i >= 0; i -= 1) {
    const anchor = new Date(nowMs);
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(1);
    anchor.setMonth(anchor.getMonth() - i);
    const startMs = anchor.getTime();
    let closed = 0;
    let callbacks = 0;
    for (const wo of closedFiltered) {
      if (wo.completedAt === null || !sameCalendarMonth(wo.completedAt, startMs)) continue;
      closed += 1;
      if (calledBack.has(wo.id)) callbacks += 1;
    }
    callbackMonths.push({ startMs, closed, callbacks, rate: closed > 0 ? callbacks / closed : 0 });
  }

  // ── Category mix, last 90 days ────────────────────────────────────────────
  const recent = closedFiltered.filter(
    (wo) => wo.completedAt !== null && wo.completedAt >= nowMs - MIX_WINDOW_MS,
  );
  const byCategory = new Map<string, number>();
  for (const wo of recent) {
    const key = wo.raw.category?.trim() || "";
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  const ranked = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, MIX_TOP).filter(([category]) => category !== "");
  const otherCount = recent.length - top.reduce((sum, [, n]) => sum + n, 0);
  const denom = recent.length > 0 ? recent.length : 1;
  const categoryMix: CategorySlice[] = top.map(([category, count]) => ({
    category,
    count,
    fraction: count / denom,
  }));
  if (otherCount > 0) categoryMix.push({ category: null, count: otherCount, fraction: otherCount / denom });

  return { weeks, callbackMonths, categoryMix, recentClosedCount: recent.length };
}

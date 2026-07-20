import type { ParsedWorkOrder } from "./types";
import { DAY_MS, addDays, sameCalendarWeek, startOfWeek } from "./time";

/**
 * Same-week close-rate timeline. Port of the Swift 90-day weekly chart: closed
 * orders bucketed by the MONDAY week of their completion; a close counts as
 * "same week" when reported and completed fall in one calendar week. The
 * current (incomplete) week is excluded so the newest point never dips from
 * partial data, and gap weeks are zero-filled so the x-axis stays continuous.
 */

export interface SameWeekPoint {
  weekStartMs: number;
  sameWeekClosedCount: number;
  totalClosedCount: number;
  /** Mean daysToComplete over this week's counted closes; 0 when none. */
  averageDaysToClose: number;
  /** sameWeek/total; 0 when the week had no closes. */
  sameWeekCloseRate: number;
}

export interface SameWeekMetrics {
  totalClosed: number;
  totalSameWeek: number;
  overallRate: number;
  /** Weighted mean across every counted close (Σdays/Σcount), not a mean of weekly means. */
  averageDaysToClose: number;
  latestClosedWeekMs: number | null;
}

interface WeekAccumulator {
  sameWeek: number;
  total: number;
  daysSum: number;
  daysCount: number;
}

export function buildSameWeekTimeline(
  closedWorkOrders: ParsedWorkOrder[],
  nowMs: number,
): { points: SameWeekPoint[]; metrics: SameWeekMetrics } {
  const cutoff = nowMs - 90 * DAY_MS;
  const startOfCutoffWeek = startOfWeek(cutoff);
  const currentWeekStart = startOfWeek(nowMs);
  const lastCompletedWeekStart = addDays(currentWeekStart, -7);

  const byWeek = new Map<number, WeekAccumulator>();
  for (const wo of closedWorkOrders) {
    if (wo.completedAt === null) continue;
    // Window opens at the cutoff's WEEK start (a partial first week still
    // charts) and closes before the current week.
    if (wo.completedAt < startOfCutoffWeek || wo.completedAt >= currentWeekStart) continue;
    const weekStart = startOfWeek(wo.completedAt);
    let acc = byWeek.get(weekStart);
    if (!acc) {
      acc = { sameWeek: 0, total: 0, daysSum: 0, daysCount: 0 };
      byWeek.set(weekStart, acc);
    }
    acc.total += 1;
    if (wo.reportedAt !== null && sameCalendarWeek(wo.reportedAt, wo.completedAt)) acc.sameWeek += 1;
    if (wo.daysToComplete !== null) {
      acc.daysSum += wo.daysToComplete;
      acc.daysCount += 1;
    }
  }

  const points: SameWeekPoint[] = [];
  let totalClosed = 0;
  let totalSameWeek = 0;
  let daysSum = 0;
  let daysCount = 0;
  let latestClosedWeekMs: number | null = null;
  // addDays (not += WEEK_MS) so a DST transition can't drift the grid off Monday.
  for (let week = startOfCutoffWeek; week <= lastCompletedWeekStart; week = addDays(week, 7)) {
    const acc = byWeek.get(week);
    const total = acc?.total ?? 0;
    const sameWeek = acc?.sameWeek ?? 0;
    points.push({
      weekStartMs: week,
      sameWeekClosedCount: sameWeek,
      totalClosedCount: total,
      averageDaysToClose: acc && acc.daysCount > 0 ? acc.daysSum / acc.daysCount : 0,
      sameWeekCloseRate: total > 0 ? sameWeek / total : 0,
    });
    totalClosed += total;
    totalSameWeek += sameWeek;
    daysSum += acc?.daysSum ?? 0;
    daysCount += acc?.daysCount ?? 0;
    if (total > 0) latestClosedWeekMs = week;
  }

  return {
    points,
    metrics: {
      totalClosed,
      totalSameWeek,
      overallRate: totalClosed > 0 ? totalSameWeek / totalClosed : 0,
      averageDaysToClose: daysCount > 0 ? daysSum / daysCount : 0,
      latestClosedWeekMs,
    },
  };
}

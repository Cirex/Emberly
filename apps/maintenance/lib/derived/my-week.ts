import { buildCallbackAnalytics } from "./callbacks";
import { techMatches } from "./my-path";
import { addDays, calendarDaysBetween, monthDayRange, startOfDay, startOfWeek } from "./time";
import type { ParsedWorkOrder } from "./types";

/**
 * The signed-in technician's own week.
 *
 * Every number here is derived from work orders the app already syncs — this
 * adds no data and no request. It deliberately reuses the existing engines
 * rather than re-deriving: the Monday-anchored week from time.ts (so a day
 * column means the same thing it does on the manager's grid), and
 * buildCallbackAnalytics for the callback rate (so "callback" means one thing
 * across the product — a callback is attributed to whoever closed the ORIGINAL
 * order, which is the whole point of tracking it).
 */

/** Callback rate over a lifetime pool is meaningless for a weekly view; the
 *  card reads "N in 90 days", so the rate is windowed to match. */
export const CALLBACK_WINDOW_DAYS = 90;

const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

export interface MyWeekDay {
  /** Single-letter column label, Monday first. */
  label: string;
  count: number;
  isToday: boolean;
}

export interface MyWeekPeriod {
  closed: number;
  /** Median whole days reported→completed; null when nothing closed. */
  medianDaysToClose: number | null;
}

export interface MyWeek {
  technician: string;
  /** "Jul 20 – Jul 26" */
  weekLabel: string;
  lastWeekLabel: string;
  thisWeek: MyWeekPeriod;
  lastWeek: MyWeekPeriod;
  /** thisWeek.closed − lastWeek.closed. */
  closedDelta: number;
  perDay: MyWeekDay[];
  /** Callback rate across the trailing window, 0–1. */
  callbackRate: number;
  callbackCount: number;
  /** True under 10 completions, where the rate is noise rather than signal. */
  callbackSmallSample: boolean;
  /**
   * Consecutive days ending today with no callback raised against this tech.
   * Capped at the window — `streakAtWindowCap` says so, so the UI can render
   * "90+" instead of claiming a precision the window can't support.
   */
  callbackFreeStreakDays: number;
  streakAtWindowCap: boolean;
  onRouteToday: number;
  urgentToday: number;
}

/** Median of a numeric list; null when empty. Even counts average the middle pair. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Closed count + median days-to-close for one tech inside a half-open window. */
function periodFor(mine: ParsedWorkOrder[], startMs: number, endMs: number): MyWeekPeriod {
  const closed = mine.filter(
    (wo) => wo.completedAt !== null && wo.completedAt >= startMs && wo.completedAt < endMs,
  );
  const spans = closed
    .map((wo) => wo.daysToComplete)
    .filter((d): d is number => d !== null);
  return { closed: closed.length, medianDaysToClose: median(spans) };
}

export function buildMyWeek(input: {
  workOrders: ParsedWorkOrder[];
  staffName: string;
  nowMs: number;
  /** Stops the tech still has to walk today, and how many are urgent. */
  onRouteToday: number;
  urgentToday: number;
}): MyWeek {
  const { workOrders, staffName, nowMs, onRouteToday, urgentToday } = input;

  const weekStart = startOfWeek(nowMs);
  const weekEnd = addDays(weekStart, 7);
  const lastWeekStart = addDays(weekStart, -7);

  // Make-ready turns are excluded for the same reason the callback engine
  // excludes them: they are unit work on a different clock, and mixing them in
  // flatters the days-to-close figure.
  const mine = workOrders.filter((wo) => !wo.isMakeReady && techMatches(staffName, wo));

  const thisWeek = periodFor(mine, weekStart, weekEnd);
  const lastWeek = periodFor(mine, lastWeekStart, weekStart);

  const todayStart = startOfDay(nowMs);
  const perDay: MyWeekDay[] = WEEKDAY_INITIALS.map((label, i) => {
    const dayStart = addDays(weekStart, i);
    const dayEnd = addDays(weekStart, i + 1);
    return {
      label,
      count: mine.filter(
        (wo) => wo.completedAt !== null && wo.completedAt >= dayStart && wo.completedAt < dayEnd,
      ).length,
      isToday: dayStart === todayStart,
    };
  });

  // Callback rate, windowed. The analytics engine is fed the window rather than
  // the whole mirror, so the denominator matches the "in N days" caption.
  const windowStart = addDays(todayStart, -CALLBACK_WINDOW_DAYS);
  const windowed = workOrders.filter(
    (wo) =>
      (wo.completedAt !== null && wo.completedAt >= windowStart) ||
      (wo.reportedAt !== null && wo.reportedAt >= windowStart),
  );
  const analytics = buildCallbackAnalytics({ workOrders: windowed, nowMs });
  const mineMetric = analytics.metrics.find(
    (m) => m.technician.trim().toLowerCase() === staffName.trim().toLowerCase(),
  );

  // Streak: days since the most recent callback attributed to this tech. The
  // callback's own reported date is the moment the work came back, so that —
  // not the original's completion — is what breaks a streak.
  const byId = new Map(workOrders.map((wo) => [wo.id, wo]));
  const myCallbacks = analytics.detailsByTechnician.get(staffName.trim()) ?? [];
  let lastCallbackAt: number | null = null;
  for (const detail of myCallbacks) {
    const reportedAt = byId.get(detail.callbackId)?.reportedAt ?? null;
    if (reportedAt !== null && (lastCallbackAt === null || reportedAt > lastCallbackAt)) {
      lastCallbackAt = reportedAt;
    }
  }
  const sinceLast =
    lastCallbackAt === null
      ? CALLBACK_WINDOW_DAYS
      : Math.max(calendarDaysBetween(startOfDay(lastCallbackAt), todayStart), 0);
  const callbackFreeStreakDays = Math.min(sinceLast, CALLBACK_WINDOW_DAYS);

  return {
    technician: staffName,
    weekLabel: monthDayRange(weekStart, addDays(weekStart, 6)),
    lastWeekLabel: monthDayRange(lastWeekStart, addDays(lastWeekStart, 6)),
    thisWeek,
    lastWeek,
    closedDelta: thisWeek.closed - lastWeek.closed,
    perDay,
    callbackRate: mineMetric?.callbackRate ?? 0,
    callbackCount: mineMetric?.callbackCount ?? 0,
    callbackSmallSample: mineMetric?.hasSmallSample ?? true,
    callbackFreeStreakDays,
    streakAtWindowCap: callbackFreeStreakDays >= CALLBACK_WINDOW_DAYS,
    onRouteToday,
    urgentToday,
  };
}

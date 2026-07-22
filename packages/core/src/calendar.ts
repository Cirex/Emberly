/**
 * Local-time calendar math shared by the work-order / make-ready engines
 * (promoted from apps/maintenance/lib/derived/time.ts). All functions are
 * pure, take/return epoch ms, and use the DEVICE's local timezone (matching
 * the Swift app's Calendar.current behavior).
 *
 * Week convention: Swift mixed Monday-anchored weeks (technician grids compute
 * mondayStartOfCurrentWeek explicitly) with locale weekOfYear (US = Sunday).
 * The port standardizes on MONDAY everywhere — one predictable convention, and
 * the one the Swift code chose when it cared enough to spell it out.
 *
 * Only the MATH lives here; month/day label formatters stay in the apps, where
 * locale and copy decisions belong.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Whole calendar days from a to b (start-of-day to start-of-day; signed). */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY_MS);
}

/** Whole calendar-day difference (floor of the raw ms delta, not day-anchored). */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

/** Monday 00:00 of the week containing ms. */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const mondayOffset = (d.getDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0 …
  d.setDate(d.getDate() - mondayOffset);
  return d.getTime();
}

export function sameCalendarWeek(aMs: number, bMs: number): boolean {
  return startOfWeek(aMs) === startOfWeek(bMs);
}

export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

export function sameCalendarMonth(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Start of the month `offset` months before (positive = back) the month containing ms. */
export function monthStartBack(ms: number, offset: number): number {
  const d = new Date(startOfMonth(ms));
  d.setMonth(d.getMonth() - offset);
  return d.getTime();
}

/** [start, end) of the month containing ms. */
export function monthInterval(ms: number): { start: number; end: number } {
  const start = startOfMonth(ms);
  const d = new Date(start);
  d.setMonth(d.getMonth() + 1);
  return { start, end: d.getTime() };
}

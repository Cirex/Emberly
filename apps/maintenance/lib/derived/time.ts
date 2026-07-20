/**
 * Local-time calendar helpers for the derived engine. All functions are pure,
 * take/return epoch ms, and use the DEVICE's local timezone (matching the
 * Swift app's Calendar.current behavior).
 *
 * Week convention: Swift mixed Monday-anchored weeks (technician grids compute
 * mondayStartOfCurrentWeek explicitly) with locale weekOfYear (US = Sunday).
 * The port standardizes on MONDAY everywhere — one predictable convention, and
 * the one the Swift code chose when it cared enough to spell it out.
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

const MONTH_ABBREV = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jul 2026" — month label for the classification grid. */
export function monthYearLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_ABBREV[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Jul 14 – Jul 20" — eyebrow range for the rolling-week columns. */
export function monthDayRange(startMs: number, endMs: number): string {
  const a = new Date(startMs);
  const b = new Date(endMs);
  return `${MONTH_ABBREV[a.getMonth()]} ${a.getDate()} – ${MONTH_ABBREV[b.getMonth()]} ${b.getDate()}`;
}

/** "Jul 14" / "Jul 14, 2025" (year only when it differs from now). */
export function abbreviatedDate(ms: number | null, nowMs: number): string {
  if (ms === null) return "—";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return `${MONTH_ABBREV[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

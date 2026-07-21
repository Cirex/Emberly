/**
 * Local-time calendar helpers for the manager derived engines. Pure functions
 * over epoch ms in the DEVICE's local timezone (same convention as the
 * maintenance app's derived/time.ts). Lease dates arrive as "YYYY-MM-DD";
 * `parseDay` reads them as LOCAL midnight — never `Date.parse`, which would
 * treat them as UTC and shift a move-in across midnight west of Greenwich.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" (tolerating a trailing time part) → local-midnight ms, or null. */
export function parseDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

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

export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

/** Start of the month `offset` months AFTER the month containing ms (negative = back). */
export function monthStartShift(ms: number, offset: number): number {
  const d = new Date(startOfMonth(ms));
  d.setMonth(d.getMonth() + offset);
  return d.getTime();
}

export function sameCalendarMonth(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

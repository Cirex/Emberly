/**
 * Local-time calendar helpers for the derived engine. The MATH was PROMOTED to
 * @emberly/core (packages/core/src/calendar.ts) so the manager app derives its
 * make-ready / work-order views on the identical week and day conventions;
 * this module re-exports it under the app's existing import path and keeps the
 * label formatters, which are display concerns and stay in the app.
 *
 * Week convention (unchanged): MONDAY-anchored everywhere.
 */

export {
  DAY_MS,
  WEEK_MS,
  addDays,
  calendarDaysBetween,
  monthInterval,
  monthStartBack,
  sameCalendarMonth,
  sameCalendarWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "@emberly/core";

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

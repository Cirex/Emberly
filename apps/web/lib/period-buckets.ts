/**
 * Calendar bucketing for time-series aggregates.
 *
 * `aggregate_resource` groups by a categorical column, which leaves every
 * "how did this change over time" question unaskable in one call — utility
 * spend by month was twelve separate range-filtered calls. This module turns a
 * date column plus an interval into a list of half-open [from, to) windows the
 * query engine can count or scan.
 *
 * Two column kinds, because they need genuinely different arithmetic:
 *
 *   - "date"      — a plain calendar DATE (`bill_date`, `date_reported`). It has
 *                   no timezone, so the arithmetic is pure calendar arithmetic
 *                   on Y/M/D and no conversion is correct here.
 *   - "timestamp" — an instant (`entered_at`, `created_at`). Which day it falls
 *                   on depends on where you stand: a 12:30am scan is the 5th in
 *                   Memphis and the 6th in UTC. These are bucketed in the
 *                   property's timezone, because "who came through the gate last
 *                   night" is a question about local nights.
 */

export type PeriodInterval = "day" | "week" | "month" | "quarter" | "year";

export const PERIOD_INTERVALS: readonly PeriodInterval[] = [
  "day", "week", "month", "quarter", "year",
];

/**
 * The property sits in Memphis (hence MLGW), so local time is America/Chicago.
 * Callers may override per request; this is the default rather than UTC because
 * a UTC day boundary splits a Memphis night in half.
 */
export const DEFAULT_TIMEZONE = "America/Chicago";

/**
 * Ceiling on buckets one aggregate may produce. A `count` costs one query per
 * bucket, so "daily since 2019" is 2,400 round trips asked innocently. Refused
 * with a message rather than clamped: a silently shortened window answers a
 * different question than the one posed.
 */
export const MAX_PERIOD_BUCKETS = 120;

export interface CalendarParts {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

export interface PeriodBucket {
  /** Human-readable bucket label: 2026-01-05, 2026-01, 2026-Q1, 2026. */
  key: string;
  /** Inclusive lower bound, formatted for the column kind. */
  from: string;
  /** EXCLUSIVE upper bound. Half-open, so no row lands in two buckets. */
  to: string;
}

// --- calendar arithmetic (no Date, no timezone) ---------------------------

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1];
}

/** Day of week, 0 = Monday … 6 = Sunday. Sakamoto's method. */
function weekday(y: number, m: number, d: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = m < 3 ? y - 1 : y;
  const sundayFirst = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
  return (sundayFirst + 6) % 7; // shift so Monday is 0
}

function addDays(p: CalendarParts, n: number): CalendarParts {
  let { y, m, d } = p;
  d += n;
  while (d > daysInMonth(y, m)) {
    d -= daysInMonth(y, m);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  while (d < 1) {
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
    d += daysInMonth(y, m);
  }
  return { y, m, d };
}

/** Floor a date to the start of the period containing it. */
export function periodStart(p: CalendarParts, interval: PeriodInterval): CalendarParts {
  switch (interval) {
    case "day": return { ...p };
    // ISO weeks start Monday — the convention every report in this codebase uses.
    case "week": return addDays(p, -weekday(p.y, p.m, p.d));
    case "month": return { y: p.y, m: p.m, d: 1 };
    case "quarter": return { y: p.y, m: Math.floor((p.m - 1) / 3) * 3 + 1, d: 1 };
    case "year": return { y: p.y, m: 1, d: 1 };
  }
}

/** The start of the NEXT period after the one starting at `p`. */
export function periodNext(p: CalendarParts, interval: PeriodInterval): CalendarParts {
  switch (interval) {
    case "day": return addDays(p, 1);
    case "week": return addDays(p, 7);
    case "month": return p.m === 12 ? { y: p.y + 1, m: 1, d: 1 } : { y: p.y, m: p.m + 1, d: 1 };
    case "quarter": return p.m >= 10 ? { y: p.y + 1, m: 1, d: 1 } : { y: p.y, m: p.m + 3, d: 1 };
    case "year": return { y: p.y + 1, m: 1, d: 1 };
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Label for the period starting at `p`. */
export function periodKey(p: CalendarParts, interval: PeriodInterval): string {
  switch (interval) {
    case "day":
    case "week": return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
    case "month": return `${pad(p.y, 4)}-${pad(p.m)}`;
    case "quarter": return `${pad(p.y, 4)}-Q${Math.floor((p.m - 1) / 3) + 1}`;
    case "year": return `${pad(p.y, 4)}`;
  }
}

export function formatDate(p: CalendarParts): string {
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/** Parse the calendar prefix of a DATE or ISO timestamp string. */
export function parseCalendarPrefix(value: string): CalendarParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

// --- timezone conversion (instants only) ----------------------------------

/** Calendar + clock parts of an instant, as seen in `tz`. */
function partsInZone(ms: number, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ms))) out[part.type] = part.value;
  return {
    y: Number(out.year), m: Number(out.month), d: Number(out.day),
    // "24" appears at midnight in some ICU versions; normalise it to 0.
    h: Number(out.hour) % 24, mi: Number(out.minute), s: Number(out.second),
  };
}

/** Offset (local - UTC) in ms at a given instant. */
function zoneOffsetMs(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms;
}

/**
 * The UTC instant of local midnight on a calendar date in `tz`.
 *
 * Iterated twice because the offset depends on the instant we are solving for:
 * the first pass uses the offset at UTC midnight, which is wrong on the days
 * either side of a DST change, and the second pass corrects it.
 */
export function zonedMidnightUtc(p: CalendarParts, tz: string): number {
  const naive = Date.UTC(p.y, p.m - 1, p.d);
  let instant = naive;
  for (let i = 0; i < 2; i += 1) instant = naive - zoneOffsetMs(instant, tz);
  return instant;
}

/** The calendar date an instant falls on, as seen in `tz`. */
export function calendarInZone(iso: string, tz: string): CalendarParts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const p = partsInZone(ms, tz);
  return { y: p.y, m: p.m, d: p.d };
}

// --- bucket construction --------------------------------------------------

export type PeriodColumnKind = "date" | "timestamp";

/** Format a bucket boundary the way the column's type expects. */
function bound(p: CalendarParts, kind: PeriodColumnKind, tz: string): string {
  return kind === "date" ? formatDate(p) : new Date(zonedMidnightUtc(p, tz)).toISOString();
}

/**
 * Build the half-open buckets covering [first, last], inclusive of the period
 * containing `last`.
 *
 * Throws when the window would exceed MAX_PERIOD_BUCKETS — see that constant.
 */
export function buildPeriodBuckets(
  first: CalendarParts,
  last: CalendarParts,
  interval: PeriodInterval,
  kind: PeriodColumnKind,
  tz: string = DEFAULT_TIMEZONE,
): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  const lastStart = periodStart(last, interval);
  let cursor = periodStart(first, interval);

  const after = (a: CalendarParts, b: CalendarParts) =>
    a.y !== b.y ? a.y > b.y : a.m !== b.m ? a.m > b.m : a.d > b.d;

  while (!after(cursor, lastStart)) {
    const next = periodNext(cursor, interval);
    buckets.push({
      key: periodKey(cursor, interval),
      from: bound(cursor, kind, tz),
      to: bound(next, kind, tz),
    });
    if (buckets.length > MAX_PERIOD_BUCKETS) {
      throw new Error(
        `That window is more than ${MAX_PERIOD_BUCKETS} ${interval} buckets. Narrow the range or use a coarser interval.`,
      );
    }
    cursor = next;
  }
  return buckets;
}

/** The bucket label a stored value belongs to, or null when unparseable. */
export function keyForValue(
  value: string,
  interval: PeriodInterval,
  kind: PeriodColumnKind,
  tz: string = DEFAULT_TIMEZONE,
): string | null {
  const parts = kind === "date" ? parseCalendarPrefix(value) : calendarInZone(value, tz);
  if (!parts) return null;
  return periodKey(periodStart(parts, interval), interval);
}

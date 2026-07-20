/**
 * Property-local time helpers. The server runs in UTC (Vercel), but the
 * property is in a single fixed zone, so "today", week/month boundaries, and
 * the hour-of-day histogram must be computed in the property's zone — not the
 * server's — or evening entries roll into the wrong day. Intl-based so it needs
 * no extra dependency. Override with PROPERTY_TIME_ZONE if the property moves.
 */

export const PROPERTY_TIME_ZONE = process.env.PROPERTY_TIME_ZONE || "America/Chicago";

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 1 = Monday … 7 = Sunday
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PROPERTY_TIME_ZONE,
  hourCycle: "h23",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The wall-clock parts of `date` in the property zone. */
export function propertyParts(date: Date): ZonedParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 1,
  };
}

/** The property zone's UTC offset (ms) at the given instant. */
function offsetMs(date: Date): number {
  const p = propertyParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of property-local midnight on the given local Y/M/D. */
function localMidnightInstant(year: number, month: number, day: number, ref: Date): Date {
  // Use the reference instant's offset; DST only differs across a transition
  // boundary, which is acceptable for day/week/month bucketing.
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs(ref));
}

/** Start of the property-local day containing `now` (a UTC instant). */
export function startOfPropertyDay(now: Date): Date {
  const p = propertyParts(now);
  return localMidnightInstant(p.year, p.month, p.day, now);
}

/** Start of the property-local ISO week (Monday) containing `now`. */
export function startOfPropertyWeek(now: Date): Date {
  const p = propertyParts(now);
  const monday = localMidnightInstant(p.year, p.month, p.day, now);
  return new Date(monday.getTime() - (p.weekday - 1) * 86_400_000);
}

/** Start of the property-local month containing `now`. */
export function startOfPropertyMonth(now: Date): Date {
  const p = propertyParts(now);
  return localMidnightInstant(p.year, p.month, 1, now);
}

/** "yyyy-MM-dd" of `date` in the property zone. */
export function propertyDayKey(date: Date): string {
  const p = propertyParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Hour of day (0-23) of `date` in the property zone. */
export function propertyHour(date: Date): number {
  return propertyParts(date).hour;
}

const SHORT_WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Short weekday name ("Mon"…"Sun") of `date` in the property zone. */
export function propertyWeekdayShort(date: Date): string {
  return SHORT_WEEKDAYS[propertyParts(date).weekday] ?? "";
}

const SHORT_DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/**
 * Formats an ISO timestamp like "Jun 24, 7:00 AM" (en-US).
 *
 * `toLocaleString` never throws on bad input — it renders "Invalid Date" —
 * so when a `fallback` is provided, unparseable input returns the fallback
 * instead. Without a fallback the raw locale output is returned unchanged.
 */
export function formatShortDateTime(iso: string, fallback?: string): string {
  if (fallback !== undefined && !Number.isFinite(Date.parse(iso))) {
    return fallback;
  }

  return new Date(iso).toLocaleString("en-US", SHORT_DATE_TIME_FORMAT);
}

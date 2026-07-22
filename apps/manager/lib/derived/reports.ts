import type { OwnerReport, ReportSummary } from "@/lib/api/reports";

/**
 * Pure derivations for the owner-report card + PAST REPORTS band. i18n-free:
 * everything returned is either a machine value or an i18n key + params the
 * component translates — same convention as the other lib/derived modules.
 */

/** "$48.2k" / "$1.24M" / "$412" — the mockup's compact money. */
export function compactMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−$" : "$";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs).toLocaleString()}`;
}

/** Localized month name for a "YYYY-MM" period ("July" / "julio"). */
export function reportMonthName(period: string, locale: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString(locale, {
    month: "long",
    timeZone: "UTC",
  });
}

/** Localized "June 2026" for the PAST REPORTS rows. */
export function reportMonthYearLabel(period: string, locale: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** One translated-ready fragment of the card's headline sentence. */
export interface ReportHeadlinePart {
  key: "occupancy" | "collected" | "delinquencyDown" | "delinquencyUp" | "turns";
  params: Record<string, string | number>;
}

/**
 * The "report ready" card's headline, mockup-shaped: "Occupancy 92.4% ▲ ·
 * collected $1.24M · delinquency down $6.1k · 9 turns completed". Null fields
 * simply drop their fragment — the deltas were omitted at generation when the
 * snapshot series was too young, and the sentence stays honest.
 */
export function reportHeadlineParts(summary: ReportSummary): ReportHeadlinePart[] {
  const parts: ReportHeadlinePart[] = [];
  if (summary.occupancyPct !== null) {
    const arrow =
      summary.occupancyMomDeltaPts === null ? "" : summary.occupancyMomDeltaPts >= 0 ? " ▲" : " ▼";
    parts.push({ key: "occupancy", params: { value: `${summary.occupancyPct.toFixed(1)}%${arrow}` } });
  }
  if (summary.collected !== null) {
    parts.push({ key: "collected", params: { amount: compactMoney(summary.collected) } });
  }
  if (summary.balanceMomDelta !== null) {
    parts.push({
      key: summary.balanceMomDelta <= 0 ? "delinquencyDown" : "delinquencyUp",
      params: { amount: compactMoney(Math.abs(summary.balanceMomDelta)) },
    });
  }
  if (summary.turnsCompleted !== null) {
    parts.push({ key: "turns", params: { count: summary.turnsCompleted } });
  }
  return parts;
}

/** One past-report row's stats line params, or null fragments dropped. */
export function pastReportStats(summary: ReportSummary): { key: "occupancy" | "collections"; value: string }[] {
  const stats: { key: "occupancy" | "collections"; value: string }[] = [];
  if (summary.occupancyPct !== null) {
    stats.push({ key: "occupancy", value: `${summary.occupancyPct.toFixed(1)}%` });
  }
  if (summary.collectionsRatePct !== null) {
    stats.push({ key: "collections", value: `${summary.collectionsRatePct.toFixed(1)}%` });
  }
  return stats;
}

/** The newest report, or null while the archive is empty/cold. */
export function latestReport(reports: OwnerReport[]): OwnerReport | null {
  return reports.length > 0 ? reports[0] : null;
}

/** The archive minus the newest entry — what the PAST REPORTS band lists. */
export function pastReports(reports: OwnerReport[]): OwnerReport[] {
  return reports.slice(1);
}

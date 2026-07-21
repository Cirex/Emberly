import { activeLocale } from "@/lib/i18n";

/**
 * Display formatting for the Money board. Money is whole-dollar (collections
 * conversations happen in dollars, not cents), compact above $10k for the
 * metric strip ("$48.2k"), and negative amounts render with a true minus.
 */

export function fmtMoney(value: number): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.round(Math.abs(value)).toLocaleString(activeLocale())}`;
}

/** Signed variant for P&L nets: +$41,730 / −$3,214. */
export function fmtMoneySigned(value: number): string {
  return value > 0 ? `+${fmtMoney(value)}` : fmtMoney(value);
}

/** Compact for the metric strip: $48.2k above 10k, plain dollars below. */
export function fmtMoneyCompact(value: number): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}$${Math.round(abs).toLocaleString(activeLocale())}`;
}

export function fmtPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits).replace(/\.0$/, "")}%`;
}

/** "Jul 2" style short date from an ISO string; empty for unparseable input. */
export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
}

/** "Mar 2024" month-year from an ISO date or "YYYY-MM" month string. */
export function fmtMonthYear(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return "";
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(activeLocale(), {
    month: "short",
    year: "numeric",
  });
}

/**
 * Currency + date formatting/parsing helpers — port of the ResMan-facing parts
 * of KrakenCore/Utilities/CurrencyFormatting.swift and DateFormatting.swift.
 * Design §3.1 (`resman/format.ts`).
 *
 * These are display/parse helpers shared by the CSV parser and the detail
 * scraper. Money is kept as `number` here (formatting only); the persisted
 * schema uses numeric(12,2), and callers round at the DB boundary.
 */

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const CURRENCY_FORMATTER_NO_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** `$1,234.56`, or `--` for null/undefined (Swift `Double?.currencyFormatted`). */
export function currencyFormatted(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return CURRENCY_FORMATTER.format(value);
}

/** `$1,235`, or `--` for null/undefined (Swift `currencyFormattedNoCents`). */
export function currencyFormattedNoCents(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return CURRENCY_FORMATTER_NO_CENTS.format(value);
}

/** `42%` (Swift `Double.percentFormatted`). */
export function percentFormatted(value: number): string {
  return `${Math.round(value)}%`;
}

/** Returns the string if non-empty, otherwise undefined (Swift `String.nonEmpty`). */
export function nonEmpty(value: string): string | undefined {
  return value.length === 0 ? undefined : value;
}

/**
 * Parse a money string the way the CSV/detail parsers do: strip `$` and thousands
 * separators, tolerate surrounding whitespace, and return `null` when the field
 * is blank or non-numeric. Kept in sync with `parseDouble` in `csv.ts`.
 */
export function parseMoney(value: string): number | null {
  const cleaned = value.trim().replace(/\$/g, "").replace(/,/g, "");
  if (cleaned.length === 0) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * MLGW bill date parsing + invoice-filename derivation.
 *
 * Ports the pure helpers from MLGWBillFileStore.swift (the disk-writing parts
 * are re-homed in `file-store.ts`, brief §2):
 *   - digitsOnly, safeFilePart
 *   - parseMLGWDate, formattedDate, rawBillDate, normalizedBillDate,
 *     billFilenameDate, desiredBillFilename
 *
 * Swift used `DateFormatter` (locale en_US_POSIX) with a small set of format
 * strings. Since JS has no format-string date parser, `parseMLGWDate` matches the
 * same shapes with explicit regexes (numeric M/d/yy(yy) and month-name
 * "MMMM d, yyyy" / "MMM d, yyyy") and returns a UTC `Date` (noon, to keep the
 * calendar day stable regardless of TZ). `formattedDate` re-emits `yyyyMMdd` /
 * `MM/dd/yyyy` via UTC getters, so the round-trip is timezone-independent.
 */

import { lineValue, cachedRegex, trimmedForCell } from "../text";

/** Split on the same Unicode line-break set Swift's `.newlines` used. */
const NEWLINES = /[\n\r\u0085\u2028\u2029]/;

/** Only the ASCII/Unicode digits of `value`; `""` for nil. Port of `digitsOnly`. */
export function digitsOnly(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.replace(/\D/g, "");
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function makeUTCDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/**
 * Parse an MLGW bill date string to a UTC `Date`, or `null`. Accepts the same
 * shapes as the Swift `parseMLGWDate`: numeric `M/d/yy` / `M/d/yyyy` and
 * month-name `MMMM d, yyyy` / `MMM d, yyyy`. Two-digit years map to 2000+yy.
 * Port of `parseMLGWDate`.
 */
export function parseMLGWDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const cleaned = trimmedForCell(value);
  if (cleaned.length === 0) return null;

  const slashFour = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/.exec(cleaned);
  if (slashFour) {
    return makeUTCDate(Number(slashFour[3]), Number(slashFour[1]), Number(slashFour[2]));
  }
  const slashTwo = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2})$/.exec(cleaned);
  if (slashTwo) {
    return makeUTCDate(2000 + Number(slashTwo[3]), Number(slashTwo[1]), Number(slashTwo[2]));
  }
  const monthName = /^([A-Za-z]+)\s+([0-9]{1,2}),\s+([0-9]{4})$/.exec(cleaned);
  if (monthName) {
    const month = MONTHS[monthName[1].toLowerCase()];
    if (month !== undefined) {
      return makeUTCDate(Number(monthName[3]), month, Number(monthName[2]));
    }
  }
  return null;
}

/**
 * Format a `Date` with the given pattern, or `""` for null. Supports the two
 * patterns MLGW uses — `yyyyMMdd` and `MM/dd/yyyy` — via UTC getters. Port of
 * `formattedDate`.
 */
export function formattedDate(date: Date | null, format: string): string {
  if (date === null) return "";
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return format
    .replace("yyyy", pad(date.getUTCFullYear(), 4))
    .replace("MM", pad(date.getUTCMonth() + 1, 2))
    .replace("dd", pad(date.getUTCDate(), 2));
}

/**
 * The raw bill-date text found in the bill body, or `null`. Looks first for an
 * inline `Date:` label value, then a `Date:` line followed by a month-name or
 * numeric date. Port of `rawBillDate`.
 */
export function rawBillDate(text: string): string | null {
  const lines = text
    .split(NEWLINES)
    .map((line) => trimmedForCell(line))
    .filter((line) => line.length > 0);
  const fromLine = lineValue("^\\s*Date\\s*:?\\s*(.*)$", lines);
  if (fromLine.length > 0) {
    return fromLine;
  }
  // Swift used `(?m)` in addition to firstMatch's implicit case-insensitive +
  // dot-matches-newline, so compile with `ism` directly.
  const regex = cachedRegex(
    "^\\s*Date\\s*:?\\s*((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+[0-9]{1,2},\\s+[0-9]{4}|[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})",
    "ism",
  );
  const match = regex.exec(text);
  return match !== null && match[1] !== undefined ? trimmedForCell(match[1]) : null;
}

/** Bill date normalized to `MM/dd/yyyy`, with an optional fallback. Port of `normalizedBillDate`. */
export function normalizedBillDate(text: string, fallback: string | null = null): string {
  const raw = rawBillDate(text) ?? fallback;
  return formattedDate(parseMLGWDate(raw), "MM/dd/yyyy");
}

/** Bill date as `yyyyMMdd` for a filename, with an optional fallback. Port of `billFilenameDate`. */
export function billFilenameDate(text: string, fallback: string | null): string {
  const raw = rawBillDate(text) ?? fallback;
  return formattedDate(parseMLGWDate(raw), "yyyyMMdd");
}

/**
 * Build the deterministic `<yyyyMMdd>-<account>[-<document>].<ext>` filename, or
 * `null` when the date or account digits are missing. Port of `desiredBillFilename`.
 */
export function desiredBillFilename(
  dateText: string,
  accountNumber: string,
  documentId: string | null | undefined,
  fileExtension: string,
): string | null {
  const datePart = formattedDate(parseMLGWDate(dateText), "yyyyMMdd");
  const accountPart = digitsOnly(accountNumber);
  if (datePart.length === 0 || accountPart.length === 0) return null;
  const documentPart = digitsOnly(documentId);
  if (documentPart.length > 0) {
    return `${datePart}-${accountPart}-${documentPart}.${fileExtension}`;
  }
  return `${datePart}-${accountPart}.${fileExtension}`;
}

/**
 * Sanitize a string for use in a filename component (keep `A-Za-z0-9._ -`,
 * collapse whitespace, trim). Port of `safeFilePart`.
 */
export function safeFilePart(value: string): string {
  return trimmedForCell(value.replace(/[^A-Za-z0-9._ -]+/g, " ").replace(/\s+/g, " "));
}

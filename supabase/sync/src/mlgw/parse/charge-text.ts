/**
 * Shared low-level helpers for the MLGW charge/fee parsers.
 *
 * These back the line-normalization, regex flag control, and the money/boundary
 * patterns that appear verbatim across MLGWChargeParser.swift,
 * MLGWFeeChargeDetailParser.swift, MLGWChargeSummaryParser.swift, and
 * MLGWUtilityChargeDetailParser.swift. They are consolidated here (there is no
 * single Swift source file) so the parsers can share one faithful copy.
 *
 * Regex flag control (brief §4): the Swift parsers switch between
 * `range(of:options:.regularExpression)` (case-SENSITIVE) and
 * `[.regularExpression, .caseInsensitive]`. The shared `../text.firstMatch`
 * forces `i`+`s`, which is wrong for the case-sensitive column-header patterns,
 * so `testPattern`/`execFirst` take an explicit flag string instead.
 */

import { cachedRegex, trimmedForCell } from "../text";

/** Swift `.newlines` CharacterSet — split on any Unicode line break. */
export const NEWLINES = /[\n\r\u0085\u2028\u2029]/;

/**
 * Split `text` into lines, collapse internal whitespace runs to a single space,
 * `trimmedForCell` each, and drop blank lines. This is the identical
 * `normalizedChargeLines` / `normalizedFeeLines` transform used throughout the
 * charge parsers.
 */
export function normalizedChargeLines(text: string): string[] {
  return text
    .split(NEWLINES)
    .map((line) => trimmedForCell(line.replace(/\s+/g, " ")))
    .filter((line) => line.length > 0);
}

/** Escape a literal string for interpolation into a RegExp. Port of `NSRegularExpression.escapedPattern(for:)`. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `pattern` matches somewhere in `text`, honoring exactly `flags` (no forced
 * `i`). The analog of Swift `text.range(of: pattern, options:) != nil`. Never
 * pass the `g` flag here (the cached instance would carry `lastIndex` state).
 */
export function testPattern(text: string, pattern: string, flags = ""): boolean {
  return cachedRegex(pattern, flags).test(text);
}

/** First match of `pattern` in `text` honoring exactly `flags`, or `null`. */
export function execFirst(text: string, pattern: string, flags = ""): RegExpExecArray | null {
  return cachedRegex(pattern, flags).exec(text);
}

/** The starting index of the first match, or `-1`. */
export function indexOfMatch(text: string, pattern: string, flags = ""): number {
  const match = execFirst(text, pattern, flags);
  return match === null ? -1 : match.index;
}

/** The end index (start + length) of the first match, or `-1`. */
export function endOfMatch(text: string, pattern: string, flags = ""): number {
  const match = execFirst(text, pattern, flags);
  return match === null ? -1 : match.index + match[0].length;
}

/** A single money value on its own line, e.g. `12.34`, `$ 1,234.56`. */
export const MONEY_LINE_PATTERN =
  "^\\$?\\s*([0-9]{1,3}(?:,[0-9]{3})*\\.[0-9]{2}|[0-9]+\\.[0-9]{2})\\s*$";

/** An inline money value, capturing the optional `$`/space prefix. */
export const MONEY_INLINE_PATTERN = "(\\$?\\s*[0-9]{1,3}(?:,[0-9]{3})*\\.[0-9]{2})";

/** The "we've left the current-charges region" boundary (without Swift's inline `(?i)`). */
export const SUMMARY_BOUNDARY =
  "\\b(?:Total\\s+Current\\s+Charges|Total\\s+Amount\\s+Due|Amount\\s+Due|Due\\s+Date|If\\s+received\\s+later|Please\\s+detach)\\b";

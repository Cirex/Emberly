/**
 * Port of KrakenCore/Services/MLGW/MLGWBillFieldParser.swift.
 *
 * Scalar field extractors over a bill's plain text: the normalized due date,
 * the "Balance Forward" amount, and the average temperature (which falls back
 * to a positional scan of the summary metrics block when there is no inline
 * `Average Temperature: NN` value).
 *
 * NB (brief §4): Swift inline `(?m)` flags are not valid in JS RegExp, so the
 * multiline "Balance Forward" patterns are compiled here with an explicit `m`
 * flag via `firstCapture` rather than through `../text.firstMatch`.
 */

import { firstMatch, parseDecimal, trimmedForCell } from "../text";
import { formattedDate, parseMLGWDate } from "../download";
import { NEWLINES, testPattern } from "./charge-text";

/** Faithful port of `normalizedDueDate(from:fallback:)`. */
export function normalizedDueDate(text: string, fallback: string | null): string {
  const numeric = firstMatch(text, "Due\\s*Date\\s*:?\\s*([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})");
  if (numeric !== null) return numeric;

  const textual = firstMatch(
    text,
    "Due\\s*Date\\s*:?\\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+[0-9]{1,2},\\s+[0-9]{4})",
  );
  if (textual !== null) {
    const date = parseMLGWDate(textual);
    if (date !== null) return formattedDate(date, "MM/dd/yyyy");
    return textual;
  }
  return fallback ?? "";
}

/** Faithful port of `balanceForwardAmount(from:)`. */
export function balanceForwardAmount(text: string): number | null {
  const patterns = [
    "^\\s*Balance\\s+Forward\\s+\\$?\\s*(-?[0-9,]+\\.[0-9]{2})\\b",
    "^\\s*Balance\\s+Foward\\s+\\$?\\s*(-?[0-9,]+\\.[0-9]{2})\\b",
  ];
  for (const pattern of patterns) {
    const amount = parseDecimal(firstCapture(text, pattern, "im"));
    if (amount !== null) return amount;
  }
  return null;
}

/** Faithful port of `averageTemperature(from:)`. */
export function averageTemperature(text: string): number | null {
  const inlineValue = firstMatch(
    text,
    "Average\\s+Temperature\\s*:?\\s*(-?[0-9]+(?:\\.[0-9]+)?)",
  );
  if (inlineValue !== null) return parseDecimal(inlineValue);

  const lines = text
    .split(NEWLINES)
    .map((line) => trimmedForCell(line))
    .filter((line) => line.length > 0);

  let labelIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (testPattern(lines[i], "Average\\s+Temperature\\s*:?", "i")) {
      labelIndex = i;
      break;
    }
  }
  if (labelIndex < 0) return null;

  const findFrom = (start: number, pattern: string): number => {
    for (let i = start; i < lines.length; i += 1) {
      if (testPattern(lines[i], pattern, "i")) return i;
    }
    return -1;
  };
  let valueAnchor = findFrom(labelIndex, "Next\\s+Reading\\s+Date\\s*:?");
  if (valueAnchor < 0) valueAnchor = findFrom(labelIndex, "Billing\\s+Cycle\\s*:?");
  if (valueAnchor < 0) valueAnchor = labelIndex;

  const metricOffset = 2;
  const values: number[] = [];
  for (let i = valueAnchor + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (testPattern(line, "^(Contact|Current\\s+Charges|Detailed\\s+Charges)\\b", "i")) break;
    if (testPattern(line, "^[A-Za-z]+\\s+[0-9]{1,2},\\s+[0-9]{4}$", "i")) continue;
    const value = standaloneSummaryMetricValue(line);
    if (value === null) continue;
    values.push(value);
    if (values.length > metricOffset) return values[metricOffset];
  }
  return null;
}

function standaloneSummaryMetricValue(line: string): number | null {
  const cleaned = line.replace(/\$/g, "").replace(/,/g, "").trim();
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(cleaned)) return null;
  return parseDecimal(cleaned);
}

/** First capture group of `pattern` (compiled with exactly `flags`), `trimmedForCell`'d, or `null`. */
function firstCapture(text: string, pattern: string, flags: string): string | null {
  const match = new RegExp(pattern, flags).exec(text);
  if (match === null || match[1] === undefined) return null;
  return trimmedForCell(match[1]);
}

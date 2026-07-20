/**
 * Port of KrakenCore/Services/MLGW/MLGWUtilityChargeDetailParser.swift.
 *
 * Pulls the per-commodity (Electric/Gas/Water) detail line — usage total,
 * amount, and the meter-reading date range — out of the "Detailed Charges"
 * section. `utilityDetailCharge` sums usage/amount across the matching meter
 * rows; `normalizedReadingDateRange` formats a `(current, previous)` date pair
 * to `MM/dd/yyyy`.
 */

import { allMatches, parseDecimal, trimmedForCell } from "../text";
import { formattedDate, parseMLGWDate } from "../download";
import { NEWLINES, escapeRegExp, testPattern } from "./charge-text";

export interface UtilityDetailCharge {
  usage: string | null;
  amount: number;
  readStartDate: string | null;
  readEndDate: string | null;
}

/** Faithful port of `utilityDetailCharge(from:type:linePrefix:)`. */
export function utilityDetailCharge(
  section: string,
  type: string,
  linePrefix: string,
): UtilityDetailCharge | null {
  const prefixPattern = `^\\s*${escapeRegExp(linePrefix)}-[0-9A-Za-z]+\\b`;
  let usageTotal = 0;
  let amountTotal = 0;
  let foundRow = false;
  let readingDateRange: { start: string; end: string } | null = null;

  // NB: unlike the fee parsers, the Swift source does NOT drop empty lines here.
  const lines = section
    .split(NEWLINES)
    .map((line) => trimmedForCell(line.replace(/\s+/g, " ")));

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line.length === 0 ||
      !testPattern(line, prefixPattern, "i") ||
      !line.toLowerCase().includes(type.toLowerCase())
    ) {
      continue;
    }

    let detail = utilityDetailValues(line, type);
    if (detail === null && index + 1 < lines.length) {
      let combinedLine = line;
      const end = Math.min(index + 2, lines.length - 1);
      for (let c = index + 1; c <= end; c += 1) {
        const continuation = lines[c];
        if (testPattern(continuation, prefixPattern, "i")) break;
        combinedLine += " " + continuation;
        detail = utilityDetailValues(combinedLine, type);
        if (detail !== null) break;
      }
    }
    if (detail === null) continue;

    const usage = parseDecimal(detail.usage);
    if (usage !== null) usageTotal += usage;
    amountTotal += detail.amount;
    readingDateRange = readingDateRange ?? utilityReadingDateRange(lines, index, type);
    foundRow = true;
  }

  if (!foundRow) return null;
  const usage = usageTotal === 0 ? null : String(usageTotal);
  return {
    usage,
    amount: amountTotal,
    readStartDate: readingDateRange?.start ?? null,
    readEndDate: readingDateRange?.end ?? null,
  };
}

function utilityDetailValues(line: string, type: string): { usage: string; amount: number } | null {
  const typeIndex = line.toLowerCase().indexOf(type.toLowerCase());
  if (typeIndex < 0) return null;
  const afterType = line.slice(typeIndex + type.length);
  const detailText = afterType.replace(/^\s*#[0-9A-Za-z-]+\s*/, "");
  const numberPattern = "([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]+)?|[0-9]+(?:\\.[0-9]+)?)";
  const values = allMatches(detailText, numberPattern);
  if (values.length < 4) return null;

  const amountText = values[values.length - 1];
  if (!/^[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}$|^[0-9]+\.[0-9]{2}$/.test(amountText)) return null;
  const amount = parseDecimal(amountText);
  if (amount === null) return null;
  const usage = values[values.length - 2];
  if (usage === undefined) return null;
  return { usage, amount };
}

function utilityReadingDateRange(
  lines: string[],
  rowIndex: number,
  type: string,
): { start: string; end: string } | null {
  const target = type.toLowerCase();
  let serviceHeaderIndex: number | null = null;
  for (let i = rowIndex - 1; i >= 0; i -= 1) {
    if (lines[i].toLowerCase() === target) {
      serviceHeaderIndex = i;
      break;
    }
  }
  const searchStart = serviceHeaderIndex ?? Math.max(0, rowIndex - 8);
  const datePattern = "(\\b[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}\\b)";
  const dates: string[] = [];
  for (let i = searchStart; i < rowIndex; i += 1) {
    dates.push(...allMatches(lines[i], datePattern));
  }
  if (dates.length < 2) return null;
  const currentDate = dates[dates.length - 2];
  const previousDate = dates[dates.length - 1];
  return normalizedReadingDateRange(currentDate, previousDate);
}

/** Faithful port of `normalizedReadingDateRange(currentFirst:previousSecond:)`. */
export function normalizedReadingDateRange(
  currentFirst: string,
  previousSecond: string,
): { start: string; end: string } | null {
  const endDate = formattedDate(parseMLGWDate(currentFirst), "MM/dd/yyyy");
  const startDate = formattedDate(parseMLGWDate(previousSecond), "MM/dd/yyyy");
  if (startDate.length === 0 || endDate.length === 0) return null;
  return { start: startDate, end: endDate };
}

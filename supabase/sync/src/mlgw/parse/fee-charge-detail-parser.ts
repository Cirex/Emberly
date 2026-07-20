/**
 * Port of KrakenCore/Services/MLGW/MLGWFeeChargeDetailParser.swift.
 *
 * The heuristics that pull itemized fee amounts (street-light fee, security
 * deposit, credit-balance transfer, …) out of the noisy "Detailed Charges" text
 * of an MLGW bill. Each helper returns a `number | null` (Swift `Decimal?`).
 * `Decimal` is ported to `number` (brief §10); exact `==` comparisons on parsed
 * two-decimal values remain reliable, but see the group TODO about float sums.
 */

import { allMatches, firstMatch, parseDecimal, replacingMatches } from "../text";
import {
  MONEY_INLINE_PATTERN,
  MONEY_LINE_PATTERN,
  SUMMARY_BOUNDARY,
  normalizedChargeLines,
  testPattern,
} from "./charge-text";

/** A `(type, labelPattern)` pair used by the stacked/labelled fee scanners. */
export interface FeePattern {
  type: string;
  labelPattern: string;
}

/** Port of `firstRepeatedMoneyAmount(after:in:)`. */
export function firstRepeatedMoneyAmount(labelPattern: string, text: string): number | null {
  const regex = new RegExp(labelPattern, "gi");
  for (const match of text.matchAll(regex)) {
    const upperBound = match.index + match[0].length;
    const afterLabel = text.slice(upperBound);
    const newline = afterLabel.indexOf("\n");
    const lineTail = newline >= 0 ? afterLabel.slice(0, newline) : afterLabel;
    const lineAmountTail = replacingMatches(lineTail, SUMMARY_BOUNDARY + ".*$", "", "i");
    const lineMoneyValues = allMatches(lineAmountTail, MONEY_INLINE_PATTERN);
    const lowerLineTail = lineTail.toLowerCase();
    const lineHasOnlyContributionAmount =
      lineMoneyValues.length === 1 && lowerLineTail.includes("total contributions");
    if (!lineHasOnlyContributionAmount) {
      const parsed = lineMoneyValues
        .map((value) => parseDecimal(value))
        .filter((value): value is number => value !== null);
      if (parsed.length > 0) return parsed[parsed.length - 1];
    }

    const boundedTail = replacingMatches(
      afterLabel.slice(0, 260),
      SUMMARY_BOUNDARY + "[\\s\\S]*$",
      "",
      "i",
    );
    const shortTail = boundedTail.slice(0, 220);
    const moneyValues = allMatches(shortTail, MONEY_INLINE_PATTERN);
    let previous: number | null = null;
    for (const value of moneyValues) {
      const amount = parseDecimal(value);
      if (amount === null) continue;
      if (previous !== null && previous === amount) return amount;
      previous = amount;
    }
  }
  return null;
}

/** Port of `stackedRepeatedLabelMoneyTotal(after:in:)`. */
export function stackedRepeatedLabelMoneyTotal(labelPattern: string, text: string): number | null {
  const lines = normalizedChargeLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    if (!testPattern(lines[index], labelPattern, "i")) continue;

    let labelCount = 0;
    let cursor = index;
    while (cursor < lines.length) {
      const candidate = lines[cursor];
      if (
        !testPattern(candidate, labelPattern, "i") ||
        firstMatch(candidate, MONEY_LINE_PATTERN) !== null
      ) {
        break;
      }
      labelCount += 1;
      cursor += 1;
    }
    if (labelCount <= 1) continue;

    const amounts: number[] = [];
    let scanIndex = cursor;
    let scannedLineCount = 0;
    while (scanIndex < lines.length && scannedLineCount < 30 && amounts.length < labelCount) {
      const candidate = lines[scanIndex];
      if (testPattern(candidate, SUMMARY_BOUNDARY, "i")) break;
      const amount = parseDecimal(firstMatch(candidate, MONEY_LINE_PATTERN));
      if (amount !== null) amounts.push(amount);
      scannedLineCount += 1;
      scanIndex += 1;
    }
    if (amounts.length !== labelCount) continue;
    return amounts.reduce((sum, value) => sum + value, 0);
  }
  return null;
}

/** Port of `stackedRepeatedFeeAmounts(in:matching:)`. */
export function stackedRepeatedFeeAmounts(
  text: string,
  feePatterns: FeePattern[],
): Record<string, number> {
  const lines = normalizedChargeLines(text);
  const moneyPattern = MONEY_LINE_PATTERN;

  const repeatedAmounts: number[] = [];
  let lineIndex = 0;
  while (lineIndex + 1 < lines.length) {
    const currentAmount = parseDecimal(firstMatch(lines[lineIndex], moneyPattern));
    const nextAmount = parseDecimal(firstMatch(lines[lineIndex + 1], moneyPattern));
    if (currentAmount !== null && currentAmount === nextAmount) {
      repeatedAmounts.push(currentAmount);
      lineIndex += 2;
    } else {
      lineIndex += 1;
    }
  }
  if (repeatedAmounts.length === 0) return {};

  const orderedLabels: string[] = [];
  for (const line of lines) {
    if (firstMatch(line, moneyPattern) !== null) continue;
    for (const fee of feePatterns) {
      if (fee.type === "Security Deposit") continue;
      if (!testPattern(line, fee.labelPattern, "i")) continue;
      if (orderedLabels[orderedLabels.length - 1] !== fee.type) {
        orderedLabels.push(fee.type);
      }
      break;
    }
  }
  if (orderedLabels.length !== repeatedAmounts.length) return {};

  const amountsByType: Record<string, number> = {};
  for (let i = 0; i < orderedLabels.length; i += 1) {
    amountsByType[orderedLabels[i]] = repeatedAmounts[i];
  }
  return amountsByType;
}

/** Port of `nearestSmallMoneyAmountBefore(labelPattern:in:maximum:)`. */
export function nearestSmallMoneyAmountBefore(
  labelPattern: string,
  text: string,
  maximum: number,
): number | null {
  const lines = normalizedChargeLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    if (!testPattern(lines[index], labelPattern, "i")) continue;
    const lowerBound = Math.max(0, index - 40);
    for (let cursor = index - 1; cursor >= lowerBound; cursor -= 1) {
      const amount = parseDecimal(firstMatch(lines[cursor], MONEY_LINE_PATTERN));
      if (amount === null || amount <= 0 || amount > maximum) continue;
      return amount;
    }
  }
  return null;
}

/** Port of `nearestRepeatedMoneyAmountBefore(labelPattern:in:)`. */
export function nearestRepeatedMoneyAmountBefore(labelPattern: string, text: string): number | null {
  const lines = normalizedChargeLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    if (!testPattern(lines[index], labelPattern, "i")) continue;
    const lowerBound = Math.max(0, index - 40);
    for (let cursor = index - 1; cursor > lowerBound; cursor -= 1) {
      const amount = parseDecimal(firstMatch(lines[cursor], MONEY_LINE_PATTERN));
      const previous = parseDecimal(firstMatch(lines[cursor - 1], MONEY_LINE_PATTERN));
      if (amount === null || previous === null || amount !== previous) continue;
      return amount;
    }
  }
  return null;
}

/** Port of `repeatedMoneyAmountAround(labelPattern:in:)`. */
export function repeatedMoneyAmountAround(labelPattern: string, text: string): number | null {
  const lines = normalizedChargeLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    if (!testPattern(lines[index], labelPattern, "i")) continue;
    const lowerBound = Math.max(0, index - 24);
    const upperBound = Math.min(lines.length - 1, index + 24);
    const counts = new Map<number, number>();
    for (let cursor = lowerBound; cursor <= upperBound; cursor += 1) {
      const amount = parseDecimal(firstMatch(lines[cursor], MONEY_LINE_PATTERN));
      if (amount === null || amount <= 0) continue;
      counts.set(amount, (counts.get(amount) ?? 0) + 1);
    }
    let best: number | null = null;
    for (const [amount, count] of counts) {
      if (count > 1 && (best === null || amount > best)) best = amount;
    }
    return best;
  }
  return null;
}

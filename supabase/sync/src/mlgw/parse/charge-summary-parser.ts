/**
 * Port of KrakenCore/Services/MLGW/MLGWChargeSummaryParser.swift.
 *
 * Extracts the "Current Charges" summary block from a bill's text — the top-of-
 * bill list of `Gas / Electric / Water / Other MLGW / Non-MLGW` totals — into
 * `ParsedCharge[]` (Swift `[Charge]`, `usage`/read-dates nil). Handles both the
 * inline `Label $12.34` form and the "stacked" form where a standalone label
 * line is followed some lines later by a standalone amount line.
 */

import type { ParsedCharge } from "../types";
import { parseDecimal, trimmedForCell } from "../text";
import { NEWLINES, escapeRegExp, indexOfMatch, testPattern } from "./charge-text";

const WANTED: Array<[rawLabel: string, type: string]> = [
  ["gas", "Gas"],
  ["electric", "Electric"],
  ["water", "Water"],
  ["other mlgw", "Other MLGW"],
  ["non-mlgw", "Non-MLGW"],
];

/** Faithful port of `summaryCurrentCharges(from:)`. */
export function summaryCurrentCharges(text: string): ParsedCharge[] {
  const pageBreak = indexOfMatch(text, "[\\n\\f]Page\\s+2\\s+of\\s+[0-9]+", "i");
  const firstPage = pageBreak >= 0 ? text.slice(0, pageBreak) : text;
  const lines = firstPage
    .split(NEWLINES)
    .map((line) => trimmedForCell(line.replace(/\s+/g, " ")))
    .filter((line) => line.length > 0);

  let inCurrentCharges = false;
  const charges: ParsedCharge[] = [];
  const seen = new Set<string>();
  const pendingStackedTypes: string[] = [];

  const appendCharge = (type: string, amount: number): void => {
    if (seen.has(type)) return;
    charges.push({ type, usage: null, amount, readStartDate: null, readEndDate: null });
    seen.add(type);
    for (let i = pendingStackedTypes.length - 1; i >= 0; i -= 1) {
      if (pendingStackedTypes[i] === type) pendingStackedTypes.splice(i, 1);
    }
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("current charges")) {
      inCurrentCharges = true;
      continue;
    }
    if (!inCurrentCharges) continue;
    if (lower.startsWith("total current charges")) {
      break;
    }

    for (const [rawLabel, type] of WANTED) {
      if (seen.has(type)) continue;
      const amount = summaryChargeAmount(line, rawLabel);
      if (amount !== null) appendCharge(type, amount);
    }

    for (const [rawLabel, type] of WANTED) {
      if (seen.has(type) || pendingStackedTypes.includes(type)) continue;
      if (isStandaloneSummaryLabel(line, rawLabel)) {
        pendingStackedTypes.push(type);
      }
    }

    const stackedType = pendingStackedTypes[0];
    if (stackedType !== undefined) {
      const amount = standaloneSummaryAmount(line);
      if (amount !== null) appendCharge(stackedType, amount);
    }
  }

  return charges;
}

function summaryChargeAmount(line: string, label: string): number | null {
  const escapedLabel = escapeRegExp(label);
  const pattern =
    `(?:^|\\s)${escapedLabel}\\s+\\$?\\s*` +
    "([0-9]{1,3}(?:,[0-9]{3})*\\.[0-9]{2}|[0-9]+\\.[0-9]{2})\\b";
  const match = execFirstGroup(line, pattern);
  return parseDecimal(match);
}

function isStandaloneSummaryLabel(line: string, label: string): boolean {
  const escapedLabel = escapeRegExp(label);
  return testPattern(line, `^\\s*${escapedLabel}\\s*$`, "i");
}

function standaloneSummaryAmount(line: string): number | null {
  const pattern = "^\\$?\\s*([0-9]{1,3}(?:,[0-9]{3})*\\.[0-9]{2}|[0-9]+\\.[0-9]{2})\\s*$";
  return parseDecimal(execFirstGroup(line, pattern));
}

/** First case-insensitive group-1 match, `trimmedForCell`'d, or `null`. */
function execFirstGroup(text: string, pattern: string): string | null {
  const match = new RegExp(pattern, "i").exec(text);
  if (match === null || match[1] === undefined) return null;
  return trimmedForCell(match[1]);
}

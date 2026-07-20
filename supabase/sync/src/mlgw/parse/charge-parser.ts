/**
 * Port of KrakenCore/Services/MLGW/MLGWChargeParser.swift.
 *
 * The top-level `parseCharges` that assembles a bill's full `ParsedCharge[]`:
 * it seeds from the summary block, overlays per-commodity detail (usage +
 * reading dates), then layers itemized MLGW / non-MLGW fees using the fee and
 * "columnized commercial" heuristics. Swift mutated a `[Charge]` in place with
 * nested closures (`appendCharge` / `replaceUtilityCharge`); the same closures
 * are reproduced over a reassignable `charges` array here.
 */

import type { ParsedCharge } from "../types";
import { allMatches, parseDecimal, regexGroupMatches } from "../text";
import { currentChargesSection } from "./charge-sections";
import { summaryCurrentCharges } from "./charge-summary-parser";
import {
  type FeePattern,
  firstRepeatedMoneyAmount,
  nearestRepeatedMoneyAmountBefore,
  nearestSmallMoneyAmountBefore,
  repeatedMoneyAmountAround,
  stackedRepeatedFeeAmounts,
  stackedRepeatedLabelMoneyTotal,
} from "./fee-charge-detail-parser";
import {
  normalizedReadingDateRange,
  utilityDetailCharge,
} from "./utility-charge-detail-parser";
import { normalizedChargeLines, indexOfMatch, testPattern } from "./charge-text";

interface UtilityPattern {
  type: string;
  linePrefix: string;
  patterns: string[];
}

const UTILITY_PATTERNS: UtilityPattern[] = [
  {
    type: "Electric",
    linePrefix: "E",
    patterns: [
      "\\bE-[0-9A-Za-z]+\\s+[A-Za-z0-9 /-]*Electric\\s+#[0-9]+\\s+[0-9]+\\s+[0-9]+\\s+[0-9]+(?:\\.[0-9]+)?\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9,]+\\.[0-9]{2})",
      "\\bE-[0-9A-Za-z]+\\s+[A-Za-z0-9 /-]*Electric\\s+[0-9]+\\s+[0-9]+\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9,]+\\.[0-9]{2})",
    ],
  },
  {
    type: "Gas",
    linePrefix: "G",
    patterns: [
      "\\bG-[0-9A-Za-z]+\\s+[A-Za-z0-9 /-]*Gas\\s+#[0-9]+\\s+[0-9]+\\s+[0-9]+\\s+[0-9]+(?:\\.[0-9]+)?\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9,]+\\.[0-9]{2})",
      "\\bG-[0-9A-Za-z]+\\s+[A-Za-z0-9 /-]*Gas\\s+[0-9]+\\s+[0-9]+\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9,]+\\.[0-9]{2})",
    ],
  },
  {
    type: "Water",
    linePrefix: "W",
    patterns: [
      "\\bW-[0-9A-Za-z]+\\s+[A-Za-z0-9 /-]*Water\\s+#[0-9]+\\s+[0-9]+\\s+[0-9]+\\s+[0-9]+(?:\\.[0-9]+)?\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9,]+\\.[0-9]{2})",
      "\\bW-[0-9A-Za-z]+\\s+[A-Za-z0-9 /-]*Water\\s+[0-9]+\\s+[0-9]+\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9,]+\\.[0-9]{2})",
    ],
  },
];

const FEE_PATTERNS: FeePattern[] = [
  { type: "Street Light Fee", labelPattern: "Street\\s+Light\\s+Fee" },
  { type: "Electrical Late Fee", labelPattern: "Electric(?:al)?\\s+Late\\s+Fee" },
  { type: "Security Deposit", labelPattern: "Security\\s+Deposit" },
  { type: "Smart Meter Connect Charge", labelPattern: "Smart\\s+Meter\\s+(?:Connect|Reconnect)\\s+Charge" },
  { type: "Credit Balance Transfer", labelPattern: "Credit\\s+Balance\\s+Transfer" },
  { type: "Share The Pennies", labelPattern: "Share\\s+The\\s+Pennies" },
  { type: "Water Cross Connection Fee", labelPattern: "Water\\s+Cross\\s+Connection\\s+Fee" },
  { type: "Leasing Outdoor Lighting", labelPattern: "Leasing\\s+Outdoor\\s+Lighting" },
  { type: "Mosquito/Rodent Control Fee", labelPattern: "Mosquito/Rodent\\s+Control\\s+Fee" },
  { type: "Sewer Charge", labelPattern: "Sewer\\s+Charge" },
  { type: "Storm Water Fee", labelPattern: "Storm\\s+Water\\s+Fee" },
  { type: "Solid Waste Fee", labelPattern: "Solid\\s+Waste\\s+Fee" },
];

function chargeKey(charge: ParsedCharge): string {
  return `${charge.type}|${charge.usage ?? ""}|${charge.amount}|${charge.readStartDate ?? ""}|${charge.readEndDate ?? ""}`;
}

/** Faithful port of `parseCharges(from:)`. */
export function parseCharges(text: string): ParsedCharge[] {
  const summaryCharges = summaryCurrentCharges(text);
  const section = currentChargesSection(text);
  let charges: ParsedCharge[] = [...summaryCharges];
  const summarizedTypes = new Set(summaryCharges.map((c) => c.type));

  const appendCharge = (
    type: string,
    usage: string | null,
    amount: number,
    readStartDate: string | null = null,
    readEndDate: string | null = null,
  ): void => {
    const candidate: ParsedCharge = { type, usage, amount, readStartDate, readEndDate };
    const key = chargeKey(candidate);
    if (charges.some((c) => chargeKey(c) === key)) return;
    charges.push(candidate);
  };

  const replaceUtilityCharge = (
    type: string,
    usage: string | null,
    amount: number,
    readStartDate: string | null = null,
    readEndDate: string | null = null,
  ): void => {
    charges = charges.filter((c) => c.type.toLowerCase() !== type.toLowerCase());
    appendCharge(type, usage, amount, readStartDate, readEndDate);
  };

  const summaryTotal = (type: string): number | null => {
    const found = summaryCharges.find((c) => c.type.toLowerCase() === type.toLowerCase());
    return found ? found.amount : null;
  };

  for (const service of UTILITY_PATTERNS) {
    const summaryAmount = summarizedTypes.has(service.type) ? summaryTotal(service.type) : null;
    const detail = utilityDetailCharge(section, service.type, service.linePrefix);
    if (detail !== null) {
      replaceUtilityCharge(
        service.type,
        detail.usage,
        summaryAmount ?? detail.amount,
        detail.readStartDate,
        detail.readEndDate,
      );
      continue;
    }
    for (const pattern of service.patterns) {
      const groups = regexGroupMatches(section, pattern)[0];
      if (groups === undefined || groups.length < 2) continue;
      const detailAmount = parseDecimal(groups[1]);
      if (detailAmount === null) continue;
      replaceUtilityCharge(service.type, groups[0], summaryAmount ?? detailAmount);
      break;
    }
  }

  const columnizedDetails = columnizedCommercialChargeDetails(section, summaryCharges);
  if (columnizedDetails.electricUsage !== null) {
    const summaryAmount = summaryTotal("Electric");
    if (summaryAmount !== null) {
      replaceUtilityCharge(
        "Electric",
        columnizedDetails.electricUsage,
        summaryAmount,
        columnizedDetails.electricReadStartDate,
        columnizedDetails.electricReadEndDate,
      );
    }
  }
  if (columnizedDetails.waterUsage !== null) {
    const summaryAmount = summaryTotal("Water");
    if (summaryAmount !== null) {
      replaceUtilityCharge(
        "Water",
        columnizedDetails.waterUsage,
        summaryAmount,
        columnizedDetails.waterReadStartDate,
        columnizedDetails.waterReadEndDate,
      );
    }
  }

  const stackedFeeAmounts = stackedRepeatedFeeAmounts(section, FEE_PATTERNS);
  const hasCreditBalanceTransfer = testPattern(section, "Credit\\s+Balance\\s+Transfer", "i");
  const stacked = (type: string): number | null => {
    const value = stackedFeeAmounts[type];
    return value === undefined ? null : value;
  };

  const amountForFee = (fee: FeePattern): number | null => {
    switch (fee.type) {
      case "Security Deposit":
        return (
          stackedRepeatedLabelMoneyTotal(fee.labelPattern, section) ??
          firstRepeatedMoneyAmount(fee.labelPattern, section)
        );
      case "Credit Balance Transfer":
        return (
          repeatedMoneyAmountAround(fee.labelPattern, section) ??
          stacked(fee.type) ??
          firstRepeatedMoneyAmount(fee.labelPattern, section)
        );
      case "Street Light Fee":
        if (hasCreditBalanceTransfer) {
          return (
            nearestSmallMoneyAmountBefore(fee.labelPattern, section, 5) ??
            stacked(fee.type) ??
            firstRepeatedMoneyAmount(fee.labelPattern, section)
          );
        }
        break;
      case "Share The Pennies":
      case "Storm Water Fee":
        if (hasCreditBalanceTransfer) {
          return (
            nearestRepeatedMoneyAmountBefore(fee.labelPattern, section) ??
            stacked(fee.type) ??
            firstRepeatedMoneyAmount(fee.labelPattern, section)
          );
        }
        break;
      default:
        break;
    }
    return stacked(fee.type) ?? firstRepeatedMoneyAmount(fee.labelPattern, section);
  };

  for (const fee of FEE_PATTERNS) {
    const amount = amountForFee(fee);
    if (amount !== null) appendCharge(fee.type, null, amount);
  }

  if (columnizedDetails.waterCrossConnectionFee !== null) {
    appendCharge("Water Cross Connection Fee", null, columnizedDetails.waterCrossConnectionFee);
  }
  if (columnizedDetails.leasingOutdoorLighting !== null) {
    appendCharge("Leasing Outdoor Lighting", null, columnizedDetails.leasingOutdoorLighting);
  }
  if (columnizedDetails.streetLightFee !== null) {
    appendCharge("Street Light Fee", null, columnizedDetails.streetLightFee);
  }
  if (columnizedDetails.sewerCharge !== null) {
    replaceUtilityCharge(
      "Sewer Charge",
      columnizedDetails.sewerUsage,
      columnizedDetails.sewerCharge,
      columnizedDetails.sewerReadStartDate,
      columnizedDetails.sewerReadEndDate,
    );
  }
  if (columnizedDetails.mosquitoRodentControlFee !== null) {
    appendCharge("Mosquito/Rodent Control Fee", null, columnizedDetails.mosquitoRodentControlFee);
  }

  return charges;
}

// MARK: - Columnized commercial charge details

interface ColumnizedCommercialChargeDetails {
  electricUsage: string | null;
  electricReadStartDate: string | null;
  electricReadEndDate: string | null;
  waterUsage: string | null;
  waterReadStartDate: string | null;
  waterReadEndDate: string | null;
  waterCrossConnectionFee: number | null;
  leasingOutdoorLighting: number | null;
  streetLightFee: number | null;
  sewerUsage: string | null;
  sewerReadStartDate: string | null;
  sewerReadEndDate: string | null;
  sewerCharge: number | null;
  mosquitoRodentControlFee: number | null;
}

function columnizedCommercialChargeDetails(
  section: string,
  summaryCharges: ParsedCharge[],
): ColumnizedCommercialChargeDetails {
  const details: ColumnizedCommercialChargeDetails = {
    electricUsage: null,
    electricReadStartDate: null,
    electricReadEndDate: null,
    waterUsage: null,
    waterReadStartDate: null,
    waterReadEndDate: null,
    waterCrossConnectionFee: null,
    leasingOutdoorLighting: null,
    streetLightFee: null,
    sewerUsage: null,
    sewerReadStartDate: null,
    sewerReadEndDate: null,
    sewerCharge: null,
    mosquitoRodentControlFee: null,
  };

  const lines = normalizedChargeLines(section);
  details.electricUsage = columnizedUtilityUsage(
    lines,
    "^E-[0-9A-Za-z]+\\b",
    "^E-[0-9A-Za-z]+\\b.*\\bElectric\\b",
    "OTHER MLGW",
  );
  const electricRange = columnizedUtilityReadingDateRange(lines, "ELECTRIC");
  if (electricRange !== null) {
    details.electricReadStartDate = electricRange.start;
    details.electricReadEndDate = electricRange.end;
  }
  details.waterUsage = columnizedUtilityUsage(
    lines,
    "^W-[0-9A-Za-z]+\\b",
    "^W-[0-9A-Za-z]+\\b.*\\bWater\\b",
    "OTHER MLGW",
  );
  const waterRange = columnizedUtilityReadingDateRange(lines, "WATER");
  if (waterRange !== null) {
    details.waterReadStartDate = waterRange.start;
    details.waterReadEndDate = waterRange.end;
  }

  const repeatedAmounts = repeatedMoneyAmounts(detailedChargeValueSection(section));
  const summary = (type: string): number | null => {
    const found = summaryCharges.find((c) => c.type.toLowerCase() === type.toLowerCase());
    return found ? found.amount : null;
  };
  const containsLabel = (pattern: string): boolean => testPattern(section, pattern, "i");

  if (containsLabel("Mosquito/Rodent\\s+Control\\s+Fee")) {
    const stackedFeePatterns: FeePattern[] = [
      { type: "Street Light Fee", labelPattern: "Street\\s+Light\\s+Fee" },
      { type: "Electrical Late Fee", labelPattern: "Electric(?:al)?\\s+Late\\s+Fee" },
      { type: "Security Deposit", labelPattern: "Security\\s+Deposit" },
      { type: "Smart Meter Connect Charge", labelPattern: "Smart\\s+Meter\\s+(?:Connect|Reconnect)\\s+Charge" },
      { type: "Mosquito/Rodent Control Fee", labelPattern: "Mosquito/Rodent\\s+Control\\s+Fee" },
      { type: "Storm Water Fee", labelPattern: "Storm\\s+Water\\s+Fee" },
    ];
    const stackedAmount = stackedRepeatedFeeAmounts(section, stackedFeePatterns)["Mosquito/Rodent Control Fee"];
    if (stackedAmount !== undefined) {
      details.mosquitoRodentControlFee = stackedAmount;
    } else {
      const first = firstRepeatedMoneyAmount("Mosquito/Rodent\\s+Control\\s+Fee", section);
      if (first !== null) {
        details.mosquitoRodentControlFee = first;
      } else {
        const standardMosquitoFee = 0.75;
        details.mosquitoRodentControlFee = findAmount(repeatedAmounts, (a) => a === standardMosquitoFee);
      }
    }
  }

  if (containsLabel("Water\\s+Cross\\s+Connection\\s+Fee")) {
    const standardMosquitoFee = 0.75;
    const otherMLGW = summary("Other MLGW");
    const otherMLGWCandidate =
      otherMLGW !== null && otherMLGW > 0 && otherMLGW <= 100 ? otherMLGW : null;
    details.waterCrossConnectionFee =
      firstRepeatedMoneyAmount("Water\\s+Cross\\s+Connection\\s+Fee", section) ??
      findAmount(repeatedAmounts, (a) => a > 0 && a <= 100 && a !== standardMosquitoFee) ??
      otherMLGWCandidate;
  }

  const leasingOtherMLGW = summary("Other MLGW");
  if (containsLabel("Leasing\\s+Outdoor\\s+Lighting") && leasingOtherMLGW !== null) {
    details.streetLightFee =
      firstRepeatedMoneyAmount("Street\\s+Light\\s+Fee", section) ??
      firstOf(repeatedAmounts.filter((a) => a > 0 && a <= 100).sort((x, y) => x - y));
    if (details.streetLightFee !== null) {
      const lighting = leasingOtherMLGW - details.streetLightFee;
      if (lighting > 0) details.leasingOutdoorLighting = lighting;
    } else {
      details.leasingOutdoorLighting = firstOf(
        repeatedAmounts.filter((a) => a > 100 && a <= leasingOtherMLGW).sort((x, y) => y - x),
      );
    }
  }

  if (containsLabel("Sewer\\s+Charge")) {
    const sewerCandidates = repeatedAmounts
      .filter((amount) => {
        if (amount <= 0) return false;
        if (details.mosquitoRodentControlFee !== null && amount === details.mosquitoRodentControlFee) {
          return false;
        }
        if (details.waterCrossConnectionFee !== null && amount === details.waterCrossConnectionFee) {
          return false;
        }
        return true;
      })
      .sort((x, y) => y - x);
    details.sewerCharge =
      firstRepeatedMoneyAmount("Sewer\\s+Charge", section) ?? firstOf(sewerCandidates);
    if (details.sewerCharge === null) {
      const nonMLGW = summary("Non-MLGW");
      const mosquito = details.mosquitoRodentControlFee;
      if (nonMLGW !== null && mosquito !== null) {
        const sewerAmount = nonMLGW - mosquito;
        if (sewerAmount > 0) details.sewerCharge = sewerAmount;
      }
    }
    if (details.sewerCharge !== null) {
      details.sewerUsage = columnizedUsageBeforeRepeatedAmount(lines, details.sewerCharge);
    }
    const dateRange = columnizedReadingDateRangeBeforeLabel(lines, "Sewer\\s+Charge");
    if (dateRange !== null) {
      details.sewerReadStartDate = dateRange.start;
      details.sewerReadEndDate = dateRange.end;
    }
  }

  if (details.mosquitoRodentControlFee === null) {
    const nonMLGW = summary("Non-MLGW");
    const sewerCharge = details.sewerCharge;
    if (nonMLGW !== null && sewerCharge !== null) {
      const remainder = nonMLGW - sewerCharge;
      if (remainder > 0 && remainder <= 10) details.mosquitoRodentControlFee = remainder;
    }
  }

  return details;
}

function findAmount(amounts: number[], predicate: (amount: number) => boolean): number | null {
  const value = amounts.find(predicate);
  return value === undefined ? null : value;
}

function firstOf(amounts: number[]): number | null {
  return amounts.length > 0 ? amounts[0] : null;
}

function detailedChargeValueSection(section: string): string {
  const end = indexOfMatch(section, "\\n\\s*Total\\s+Amount\\s+Due\\b", "i");
  return end < 0 ? section : section.slice(0, end);
}

function repeatedMoneyAmounts(text: string): number[] {
  const moneyPattern = "([0-9]{1,3}(?:,[0-9]{3})*\\.[0-9]{2}|[0-9]+\\.[0-9]{2})";
  const amounts = allMatches(text, moneyPattern)
    .map((value) => parseDecimal(value))
    .filter((value): value is number => value !== null);
  if (amounts.length <= 1) return [];

  const repeated: number[] = [];
  for (let index = 1; index < amounts.length; index += 1) {
    if (amounts[index] === amounts[index - 1] && !repeated.includes(amounts[index])) {
      repeated.push(amounts[index]);
    }
  }
  return repeated;
}

function columnizedUtilityUsage(
  lines: string[],
  totalRowPattern: string,
  includedUsageRowPattern: string,
  boundaryHeader: string,
): string | null {
  let boundaryIndex = -1;
  const boundaryLower = boundaryHeader.toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toLowerCase() === boundaryLower) {
      boundaryIndex = i;
      break;
    }
  }
  if (boundaryIndex < 0) return null;

  let totalRowCount = 0;
  let includedRowCount = 0;
  for (let i = 0; i < boundaryIndex; i += 1) {
    if (testPattern(lines[i], totalRowPattern, "i")) totalRowCount += 1;
    if (testPattern(lines[i], includedUsageRowPattern, "i")) includedRowCount += 1;
  }
  if (totalRowCount <= 0 || includedRowCount <= 0) return null;

  const headerEndIndex = chargeColumnHeaderEndIndex(lines, boundaryIndex);
  if (headerEndIndex === null) return null;

  const numericValues: number[] = [];
  for (let i = headerEndIndex + 1; i < lines.length; i += 1) {
    if (testPattern(lines[i], "^[A-Z][A-Z /-]+$", "")) break;
    const value = parseDecimal(numericLineValue(lines[i]));
    if (value !== null) numericValues.push(value);
  }
  if (numericValues.length < totalRowCount + includedRowCount) return null;

  const usageValues = numericValues.slice(totalRowCount, totalRowCount + includedRowCount);
  const usageTotal = usageValues.reduce((sum, value) => sum + value, 0);
  if (usageTotal <= 0) return null;
  return String(usageTotal);
}

function columnizedUtilityReadingDateRange(
  lines: string[],
  serviceHeader: string,
): { start: string; end: string } | null {
  const target = serviceHeader.toLowerCase();
  let serviceIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toLowerCase() === target) {
      serviceIndex = i;
      break;
    }
  }
  if (serviceIndex < 0) return null;

  const datePattern = "(\\b[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}\\b)";
  const dates: string[] = [];
  for (let i = serviceIndex + 1; i < lines.length; i += 1) {
    dates.push(...allMatches(lines[i], datePattern));
  }
  if (dates.length < 2) return null;
  return normalizedReadingDateRange(dates[0], dates[1]);
}

function columnizedReadingDateRangeBeforeLabel(
  lines: string[],
  labelPattern: string,
): { start: string; end: string } | null {
  let labelIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (testPattern(lines[i], labelPattern, "i")) {
      labelIndex = i;
      break;
    }
  }
  if (labelIndex < 0) return null;

  const datePattern = "(\\b[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}\\b)";
  const startIndex = Math.max(0, labelIndex - 10);
  const dates: string[] = [];
  for (let i = startIndex; i < labelIndex; i += 1) {
    dates.push(...allMatches(lines[i], datePattern));
  }
  if (dates.length < 2) return null;
  const currentDate = dates[dates.length - 2];
  const previousDate = dates[dates.length - 1];
  return normalizedReadingDateRange(currentDate, previousDate);
}

function columnizedUsageBeforeRepeatedAmount(lines: string[], amount: number): string | null {
  const numericValues: number[] = [];
  for (const line of lines) {
    const value = numericLineValue(line);
    if (value === null) continue;
    const decimalValue = parseDecimal(value);
    if (decimalValue !== null) numericValues.push(decimalValue);
  }
  if (numericValues.length <= 2) return null;

  for (let index = 1; index < numericValues.length; index += 1) {
    if (numericValues[index] !== amount) continue;
    const usage = numericValues[index - 1];
    if (usage <= 0 || usage === amount) continue;
    return String(usage);
  }
  return null;
}

function chargeColumnHeaderEndIndex(lines: string[], startIndex: number): number | null {
  let multiplierIndex: number | null = null;
  let usageIndex: number | null = null;
  let amountIndex: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    if (index <= startIndex) continue;
    switch (lines[index].toLowerCase()) {
      case "multiplier":
        multiplierIndex = index;
        break;
      case "usage":
        if (multiplierIndex !== null) usageIndex = index;
        break;
      case "amount":
        if (usageIndex !== null) amountIndex = index;
        break;
      case "total":
        if (amountIndex !== null) return index;
        break;
      default:
        break;
    }
  }
  return null;
}

function numericLineValue(line: string): string | null {
  const pattern = "^-?[0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]+)?$|^-?[0-9]+(?:\\.[0-9]+)?$";
  return testPattern(line, pattern, "") ? line : null;
}

/**
 * Port of KrakenCore/Services/MLGW/MLGWBillSummaries.swift.
 *
 * Flattens parsed bills into the JSON-serializable `BillJSONSummary` shape the
 * script core returns: per bill, charges are grouped by type (in a stable,
 * MLGW-preferred order), usages are comma-joined, amounts summed, and the first
 * non-empty reading dates carried through.
 *
 * `decimalText` mirrors `NSDecimalNumber.stringValue`. See the group TODO: JS
 * `String(number)` can render trailing-zero/precision differently than Swift's
 * `Decimal` (e.g. `12.5` vs a preserved `12.50`).
 */

import type { BillJSONCharge, BillJSONSummary, ParsedBill, ParsedCharge } from "../types";

/** Port of `decimalText(_:)` — `""` for nil, else the plain numeric string. */
export function decimalText(value: number | null): string {
  return value === null ? "" : String(value);
}

/** Faithful port of `billSummaries(_:)`. */
export function billSummaries(bills: ParsedBill[]): BillJSONSummary[] {
  const chargeTypes = orderedChargeTypes(bills);
  return bills.map((bill) => {
    const grouped = new Map<string, ParsedCharge[]>();
    for (const charge of bill.charges) {
      const bucket = grouped.get(charge.type);
      if (bucket === undefined) grouped.set(charge.type, [charge]);
      else bucket.push(charge);
    }

    const charges: BillJSONCharge[] = [];
    for (const type of chargeTypes) {
      const items = grouped.get(type);
      if (items === undefined || items.length === 0) continue;
      const usage = items
        .map((item) => item.usage)
        .filter((value): value is string => value !== null && value.length > 0)
        .join(", ");
      const amount = items.reduce((sum, item) => sum + item.amount, 0);
      const readStartDate =
        items
          .map((item) => item.readStartDate)
          .filter((value): value is string => value !== null && value.length > 0)[0] ?? "";
      const readEndDate =
        items
          .map((item) => item.readEndDate)
          .filter((value): value is string => value !== null && value.length > 0)[0] ?? "";
      charges.push({ type, usage, total: decimalText(amount), readStartDate, readEndDate });
    }

    return {
      documentId: bill.documentId,
      isCurrent: bill.isCurrent,
      accountNumber: bill.accountNumber,
      billDate: bill.billDate,
      amountDue: decimalText(bill.amountDue),
      balanceForward: decimalText(bill.balanceForward),
      averageTemperature: decimalText(bill.averageTemperature),
      dueDate: bill.dueDate,
      billFor: bill.billFor,
      servicesAt: bill.servicesAt,
      filePath: bill.filePath,
      charges,
    };
  });
}

const PREFERRED_CHARGE_TYPES = [
  "Gas",
  "Electric",
  "Water",
  "Other MLGW",
  "Non-MLGW",
  "Street Light Fee",
  "Electrical Late Fee",
  "Security Deposit",
  "Smart Meter Connect Charge",
  "Credit Balance Transfer",
  "Share The Pennies",
  "Water Cross Connection Fee",
  "Leasing Outdoor Lighting",
  "Mosquito/Rodent Control Fee",
  "Sewer Charge",
  "Storm Water Fee",
  "Solid Waste Fee",
];

/** Faithful port of `orderedChargeTypes(from:)`. */
export function orderedChargeTypes(bills: ParsedBill[]): string[] {
  const types = new Set(bills.flatMap((bill) => bill.charges.map((charge) => charge.type)));
  const preferredTypes = PREFERRED_CHARGE_TYPES.filter((type) => types.has(type));
  const remaining = [...types].filter((type) => !PREFERRED_CHARGE_TYPES.includes(type)).sort();
  return [...preferredTypes, ...remaining];
}

/**
 * Port of KrakenCore/Services/MLGW/MLGWParser+ChargeTotals.swift.
 *
 * The charge-type → column mapping. Swift `applyAdditionalChargeTotals` mutated
 * an `MLGWBill`; the pure port `additionalChargeTotals(dto)` returns the 14
 * itemized fee-total columns for `MlgwBillRow`. A "detailed" fee total (summed
 * from the itemized charge lines whose normalized type is in the set) wins over
 * the aggregate "Other MLGW"/"Non-MLGW" total; a non-MLGW detailed line whose
 * amount equals the whole amount-due (≥ $50) is dropped to avoid double-counting.
 *
 * Charge-type keyword sets (normalized: lowercased, non-alphanumerics → spaces):
 *   other_mlgw_total      ← aggregate "Other MLGW", else detailed {street light
 *                            fee, electric(al) late fee, security deposit, smart
 *                            meter connect/reconnect charge, credit balance
 *                            transfer, share the pennies, water cross connection
 *                            fee, leasing outdoor lighting}
 *   non_mlgw_total        ← aggregate "Non-MLGW", else detailed {mosquito rodent
 *                            control fee, sewer charge, storm water fee, solid
 *                            waste fee}
 *   street_light_fee_total            ← {street light fee}
 *   electrical_late_fee_total         ← {electric late fee, electrical late fee}
 *   security_deposit_total            ← {security deposit}
 *   smart_meter_connect_charge_total  ← {smart meter connect charge, smart meter reconnect charge}
 *   credit_balance_transfer_total     ← {credit balance transfer}
 *   share_the_pennies_total           ← {share the pennies}
 *   water_cross_connection_fee_total  ← {water cross connection fee}
 *   leasing_outdoor_lighting_total    ← {leasing outdoor lighting}
 *   mosquito_rodent_control_fee_total ← {mosquito rodent control fee}
 *   sewer_charge_total                ← {sewer charge}
 *   storm_water_fee_total             ← {storm water fee}
 *   solid_waste_fee_total             ← {solid waste fee}
 *
 * (The per-commodity gas/electric/water/sewer usage + totals are mapped in
 * `bill-import.ts`, matching the Swift `importBillsCooperatively` split.)
 */

import type { MLGWBillDTO, MlgwBillChargeDTO } from "../types";
import { parseAmount } from "./model-keys";

const OTHER_MLGW_DETAILED_CHARGE_TYPES = new Set([
  "street light fee",
  "electric late fee",
  "electrical late fee",
  "security deposit",
  "smart meter connect charge",
  "smart meter reconnect charge",
  "credit balance transfer",
  "share the pennies",
  "water cross connection fee",
  "leasing outdoor lighting",
]);

const NON_MLGW_DETAILED_CHARGE_TYPES = new Set([
  "mosquito rodent control fee",
  "sewer charge",
  "storm water fee",
  "solid waste fee",
]);

const STREET_LIGHT_FEE_CHARGE_TYPES = new Set(["street light fee"]);
const ELECTRICAL_LATE_FEE_CHARGE_TYPES = new Set(["electric late fee", "electrical late fee"]);
const SECURITY_DEPOSIT_CHARGE_TYPES = new Set(["security deposit"]);
const SMART_METER_CONNECT_CHARGE_TYPES = new Set([
  "smart meter connect charge",
  "smart meter reconnect charge",
]);
const CREDIT_BALANCE_TRANSFER_CHARGE_TYPES = new Set(["credit balance transfer"]);
const SHARE_THE_PENNIES_CHARGE_TYPES = new Set(["share the pennies"]);
const WATER_CROSS_CONNECTION_FEE_CHARGE_TYPES = new Set(["water cross connection fee"]);
const LEASING_OUTDOOR_LIGHTING_CHARGE_TYPES = new Set(["leasing outdoor lighting"]);
const MOSQUITO_RODENT_CONTROL_FEE_CHARGE_TYPES = new Set(["mosquito rodent control fee"]);
const SEWER_CHARGE_TYPES = new Set(["sewer charge"]);
const STORM_WATER_FEE_CHARGE_TYPES = new Set(["storm water fee"]);
const SOLID_WASTE_FEE_CHARGE_TYPES = new Set(["solid waste fee"]);

/** The itemized fee-total columns of `MlgwBillRow` produced from a DTO. */
export interface AdditionalChargeTotals {
  other_mlgw_total: number | null;
  non_mlgw_total: number | null;
  street_light_fee_total: number | null;
  electrical_late_fee_total: number | null;
  security_deposit_total: number | null;
  smart_meter_connect_charge_total: number | null;
  credit_balance_transfer_total: number | null;
  share_the_pennies_total: number | null;
  water_cross_connection_fee_total: number | null;
  leasing_outdoor_lighting_total: number | null;
  mosquito_rodent_control_fee_total: number | null;
  sewer_charge_total: number | null;
  storm_water_fee_total: number | null;
  solid_waste_fee_total: number | null;
}

/** Pure port of `applyAdditionalChargeTotals(for:to:)`. */
export function additionalChargeTotals(record: MLGWBillDTO): AdditionalChargeTotals {
  return {
    other_mlgw_total: additionalChargeTotal(record, "Other MLGW", OTHER_MLGW_DETAILED_CHARGE_TYPES),
    non_mlgw_total: additionalChargeTotal(record, "Non-MLGW", NON_MLGW_DETAILED_CHARGE_TYPES),
    street_light_fee_total: detailedChargeTotal(record, STREET_LIGHT_FEE_CHARGE_TYPES),
    electrical_late_fee_total: detailedChargeTotal(record, ELECTRICAL_LATE_FEE_CHARGE_TYPES),
    security_deposit_total: detailedChargeTotal(record, SECURITY_DEPOSIT_CHARGE_TYPES),
    smart_meter_connect_charge_total: detailedChargeTotal(record, SMART_METER_CONNECT_CHARGE_TYPES),
    credit_balance_transfer_total: detailedChargeTotal(record, CREDIT_BALANCE_TRANSFER_CHARGE_TYPES),
    share_the_pennies_total: detailedChargeTotal(record, SHARE_THE_PENNIES_CHARGE_TYPES),
    water_cross_connection_fee_total: detailedChargeTotal(record, WATER_CROSS_CONNECTION_FEE_CHARGE_TYPES),
    leasing_outdoor_lighting_total: detailedChargeTotal(record, LEASING_OUTDOOR_LIGHTING_CHARGE_TYPES),
    mosquito_rodent_control_fee_total: detailedChargeTotal(record, MOSQUITO_RODENT_CONTROL_FEE_CHARGE_TYPES),
    sewer_charge_total: detailedChargeTotal(record, SEWER_CHARGE_TYPES),
    storm_water_fee_total: detailedChargeTotal(record, STORM_WATER_FEE_CHARGE_TYPES),
    solid_waste_fee_total: detailedChargeTotal(record, SOLID_WASTE_FEE_CHARGE_TYPES),
  };
}

/** Port of `charge(_:type:)` — the first charge whose type matches `type` (case-insensitively). */
export function charge(record: MLGWBillDTO, type: string): MlgwBillChargeDTO | null {
  const lower = type.toLowerCase();
  return record.charges.find((item) => item.type.toLowerCase() === lower) ?? null;
}

/** Port of `additionalChargeTotal(for:aggregateType:detailedTypes:)`. */
export function additionalChargeTotal(
  record: MLGWBillDTO,
  aggregateType: string,
  detailedTypes: Set<string>,
): number | null {
  const detailedTotal = summedValidatedDetailedChargeTotal(record, detailedTypes);
  if (detailedTotal !== null) return detailedTotal;

  const lower = aggregateType.toLowerCase();
  const aggregateTotal = summedChargeTotal(
    record.charges.filter((item) => item.type.toLowerCase() === lower),
  );
  if (aggregateTotal !== null) return aggregateTotal;

  return null;
}

/** Port of `detailedChargeTotal(for:types:)`. */
export function detailedChargeTotal(record: MLGWBillDTO, types: Set<string>): number | null {
  return summedValidatedDetailedChargeTotal(record, types);
}

function summedChargeTotal(charges: MlgwBillChargeDTO[]): number | null {
  const amounts = charges
    .map((item) => parseAmount(item.total))
    .filter((value): value is number => value !== null);
  if (amounts.length === 0) return null;
  return amounts.reduce((sum, value) => sum + value, 0);
}

function summedValidatedDetailedChargeTotal(
  record: MLGWBillDTO,
  types: Set<string>,
): number | null {
  const amountDue = parseAmount(record.amountDue);
  return summedChargeTotal(
    record.charges.filter((item) => {
      const normalizedType = normalizedChargeType(item.type);
      if (!types.has(normalizedType)) return false;
      const chargeAmount = parseAmount(item.total);
      if (
        NON_MLGW_DETAILED_CHARGE_TYPES.has(normalizedType) &&
        amountDue !== null &&
        amountDue >= 50 &&
        chargeAmount !== null &&
        amountsEqual(chargeAmount, amountDue)
      ) {
        return false;
      }
      return true;
    }),
  );
}

/** Port of `normalizedChargeType(_:)`. */
export function normalizedChargeType(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Port of `amountsEqual(_:_:)` — nil-aware, tolerance 1e-4. */
export function amountsEqual(lhs: number | null, rhs: number | null): boolean {
  if (lhs === null && rhs === null) return true;
  if (lhs === null || rhs === null) return false;
  return Math.abs(lhs - rhs) < 0.0001;
}

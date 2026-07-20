/**
 * Port of KrakenCore/Services/MLGW/MLGWParser+BillImport.swift (pure subset).
 *
 * Swift `importBillsCooperatively` mutated SwiftData `MLGWBill`/`MLGWAccount`
 * objects in a `ModelContext`. Per brief §1 this becomes pure row mapping:
 *   - `toBillRow(dto, property)`  -> `MlgwBillRow | null` (the parsed DTO in `raw`)
 *   - `toAccountRow(dto, property, unit?)` -> `MlgwAccountRow`
 * The job layer does the fetch/dedupe/`upsertMirror`/save that the Swift did.
 *
 * Notes:
 *   - `toBillRow` returns `null` when the document id yields no document key
 *     (Swift `guard let id = documentKey(...) else { continue }`).
 *   - `sewer_total` is left `null`: the Swift importer sets sewer usage + read
 *     dates from the "Sewer Charge" charge but never assigns `bill.sewerTotal`
 *     (the itemized amount lives in `sewer_charge_total`). Preserved faithfully.
 *   - account `due_now`/`due_date` come from the account-list sync, not bill
 *     import, so they are `null` here (the upsert must not clobber them).
 */

import type {
  BillJSONSummary,
  MLGWBillDTO,
  MLGWSyncProperty,
  MlgwAccountRow,
  MlgwBillRow,
} from "../types";
import { additionalChargeTotals, charge } from "./charge-totals";
import {
  documentKey,
  isHouseAccount,
  isoDateString,
  makeAccountIdFromDTO,
  parseAmount,
  parseDate,
  sanitizedServiceAddress,
} from "./model-keys";

/** Structural map `BillJSONSummary` -> `MLGWBillDTO` (identical field set + charges). */
export function buildBillDTO(summary: BillJSONSummary): MLGWBillDTO {
  return {
    accountNumber: summary.accountNumber,
    documentId: summary.documentId,
    isCurrent: summary.isCurrent,
    billDate: summary.billDate,
    amountDue: summary.amountDue,
    balanceForward: summary.balanceForward,
    averageTemperature: summary.averageTemperature,
    dueDate: summary.dueDate,
    billFor: summary.billFor,
    servicesAt: summary.servicesAt,
    filePath: summary.filePath,
    charges: summary.charges.map((item) => ({
      type: item.type,
      usage: item.usage,
      total: item.total,
      readStartDate: item.readStartDate,
      readEndDate: item.readEndDate,
    })),
  };
}

/** Pure port of the per-record bill upsert of `importBillsCooperatively`. */
export function toBillRow(record: MLGWBillDTO, property: MLGWSyncProperty): MlgwBillRow | null {
  const documentId = record.documentId.trim();
  const id = documentKey(property.id, documentId);
  if (id === null) return null;

  const accountId = makeAccountIdFromDTO(record, property.id);
  const gasCharge = charge(record, "Gas");
  const electricCharge = charge(record, "Electric");
  const waterCharge = charge(record, "Water");
  const sewerCharge = charge(record, "Sewer Charge");
  const totals = additionalChargeTotals(record);

  return {
    id,
    document_key: id,
    mlgw_account_id: accountId,
    resman_property_id: property.id,
    document_id: documentId,
    is_current: record.isCurrent,
    bill_date: isoDateString(parseDate(record.billDate)),
    due_date: isoDateString(parseDate(record.dueDate)),
    amount_due: parseAmount(record.amountDue),
    balance_forward: parseAmount(record.balanceForward),
    average_temperature: parseAmount(record.averageTemperature),
    bill_for: record.billFor,
    file_path: record.filePath,
    gas_usage: gasCharge?.usage ?? "",
    gas_read_start_date: isoDateString(parseDate(gasCharge?.readStartDate ?? "")),
    gas_read_end_date: isoDateString(parseDate(gasCharge?.readEndDate ?? "")),
    gas_total: parseAmount(gasCharge?.total),
    electric_usage: electricCharge?.usage ?? "",
    electric_read_start_date: isoDateString(parseDate(electricCharge?.readStartDate ?? "")),
    electric_read_end_date: isoDateString(parseDate(electricCharge?.readEndDate ?? "")),
    electric_total: parseAmount(electricCharge?.total),
    water_usage: waterCharge?.usage ?? "",
    water_read_start_date: isoDateString(parseDate(waterCharge?.readStartDate ?? "")),
    water_read_end_date: isoDateString(parseDate(waterCharge?.readEndDate ?? "")),
    water_total: parseAmount(waterCharge?.total),
    sewer_usage: sewerCharge?.usage ?? "",
    sewer_read_start_date: isoDateString(parseDate(sewerCharge?.readStartDate ?? "")),
    sewer_read_end_date: isoDateString(parseDate(sewerCharge?.readEndDate ?? "")),
    sewer_total: null,
    other_mlgw_total: totals.other_mlgw_total,
    non_mlgw_total: totals.non_mlgw_total,
    street_light_fee_total: totals.street_light_fee_total,
    electrical_late_fee_total: totals.electrical_late_fee_total,
    security_deposit_total: totals.security_deposit_total,
    smart_meter_connect_charge_total: totals.smart_meter_connect_charge_total,
    credit_balance_transfer_total: totals.credit_balance_transfer_total,
    share_the_pennies_total: totals.share_the_pennies_total,
    water_cross_connection_fee_total: totals.water_cross_connection_fee_total,
    leasing_outdoor_lighting_total: totals.leasing_outdoor_lighting_total,
    mosquito_rodent_control_fee_total: totals.mosquito_rodent_control_fee_total,
    sewer_charge_total: totals.sewer_charge_total,
    storm_water_fee_total: totals.storm_water_fee_total,
    solid_waste_fee_total: totals.solid_waste_fee_total,
    raw: record,
  };
}

/**
 * Pure port of the per-record account upsert of `importBillsCooperatively`.
 * `unit` carries the resolved unit linkage (see `unit-matching.resolveAccountUnit`);
 * omit it for the non-linking path (Swift `linkAccountsToUnits == false`).
 */
export function toAccountRow(
  record: MLGWBillDTO,
  property: MLGWSyncProperty,
  unit?: { resman_unit_id: string; unit_number: string },
): MlgwAccountRow {
  const serviceAddress = sanitizedServiceAddress(record.servicesAt);
  const house = isHouseAccount(serviceAddress);
  const resolved = house ? { resman_unit_id: "", unit_number: "" } : unit ?? { resman_unit_id: "", unit_number: "" };

  return {
    id: makeAccountIdFromDTO(record, property.id),
    resman_property_id: property.id,
    property_name: property.name,
    account_number: record.accountNumber,
    service_address: serviceAddress,
    resman_unit_id: resolved.resman_unit_id,
    unit_number: resolved.unit_number,
    is_house_account: house,
    due_now: null,
    due_date: null,
  };
}

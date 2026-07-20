/**
 * MLGW parse group barrel — charge/payment parsing + DTO/row mapping.
 *
 * Ports of KrakenCore/Services/MLGW/MLGW{Charge*,Fee*,Utility*,BillField,
 * BillAddress,BillContextFields,DownloadedBill,Bill,BillParseCoordinator,
 * BillSummaries}Parser*.swift and MLGWParser+{BillImport,ChargeTotals,
 * UnitMatching,ModelKeys,DocumentStatuses,PaymentImport}.swift — the layer that
 * turns downloaded bill text into structured charges/totals and DB-row DTOs.
 * Maps commodity charges to the per-commodity columns and fee lines to the
 * itemized fee columns of mlgw_bills; the full parsed charge array lands in raw
 * jsonb. Design §4.1/§4.3.
 */

// Charge / fee / utility / summary parsing
export { parseCharges } from "./charge-parser";
export { currentChargesSection } from "./charge-sections";
export { summaryCurrentCharges } from "./charge-summary-parser";
export {
  type FeePattern,
  firstRepeatedMoneyAmount,
  nearestRepeatedMoneyAmountBefore,
  nearestSmallMoneyAmountBefore,
  repeatedMoneyAmountAround,
  stackedRepeatedFeeAmounts,
  stackedRepeatedLabelMoneyTotal,
} from "./fee-charge-detail-parser";
export {
  type UtilityDetailCharge,
  normalizedReadingDateRange,
  utilityDetailCharge,
} from "./utility-charge-detail-parser";

// Bill field / address / context parsing
export { averageTemperature, balanceForwardAmount, normalizedDueDate } from "./bill-field-parser";
export { cleanServiceAddress } from "./bill-address-parser";
export { billContextFields } from "./bill-context-fields";

// Bill parsing + coordination
export { parseBill } from "./bill-parser";
export {
  BillParseCoordinator,
  type BillParseProfileSummary,
  type BillParseResults,
  type BillParseWork,
} from "./bill-parse-coordinator";
export {
  type ParseDownloadedBillsOptions,
  parseDownloadedBills,
  uniqueParsedBills,
} from "./downloaded-bill-parser";
export { billSummaries, decimalText, orderedChargeTypes } from "./bill-summaries";

// DTO / row mapping (pure ports of the SwiftData importers)
export { buildBillDTO, toAccountRow, toBillRow } from "./bill-import";
export {
  type AdditionalChargeTotals,
  additionalChargeTotal,
  additionalChargeTotals,
  amountsEqual,
  charge,
  detailedChargeTotal,
  normalizedChargeType,
} from "./charge-totals";
export {
  type PropertyUnitInput,
  type ResolvedAccountUnit,
  buildUnitLookup,
  matchedUnit,
  resolveAccountUnit,
} from "./unit-matching";
export {
  documentKey,
  isHouseAccount,
  isoDateString,
  makeAccountId,
  makeAccountIdFromDTO,
  normalizedAccountNumber,
  normalizedServiceAddress,
  parseAmount,
  parseDate,
  sanitizedServiceAddress,
} from "./model-keys";
export { mergeBillDocumentStatuses } from "./document-statuses";
export { type PaymentDetailFields, makePaymentId, toPaymentRow } from "./payment-import";

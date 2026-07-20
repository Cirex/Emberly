/**
 * Port of KrakenCore/Services/MLGW/MLGWParser+PaymentImport.swift (pure subset).
 *
 * `toPaymentRow` maps one scraped `MLGWPaymentDTO` to an `MlgwPaymentRow`,
 * preferring detail-page values over list values (with over-capture guards) and
 * normalizing the payment method. **All card fields are dropped** (brief §"DROP
 * ALL CARD FIELDS"): cardType / maskedCardNumber / cardLastFour / nameOnCard /
 * cardExpirationDate are intentionally never persisted, so the entire
 * card-masking / last-four logic from the Swift importer is omitted.
 *
 * Two decouplings from the SwiftData importer:
 *   - `mlgw_account_id` is left `null`. Swift linked the payment to an
 *     `MLGWAccount` by normalized account number; that FK linkage is a job-layer
 *     concern (it needs the persisted account rows).
 *   - The detail-page fallback fields are INJECTED (`detail` param) rather than
 *     parsed here. Swift called `paymentDetailFields(record.detailText)` inline,
 *     but that HTML parser lives in the (separate) payment group; the caller
 *     passes the parsed fields when `detailText` is non-blank. `PaymentDetailFields`
 *     is structurally compatible with the payment group's
 *     `MLGWPaymentDetailFields` for the fields consumed here.
 */

import type { MLGWPaymentDTO, MlgwPaymentRow } from "../types";
import { trimmedForCell } from "../text";
import { isoDateString, normalizedAccountNumber, parseAmount, parseDate } from "./model-keys";

/** The detail-page fields `toPaymentRow` consumes (subset of `MLGWPaymentDetailFields`). */
export interface PaymentDetailFields {
  status: string;
  amount: string;
  paidDate: string;
  paymentMethod: string;
  authorizationNumber: string;
}

/**
 * Pure port of the per-record body of `importPaymentsCooperatively`. Returns
 * `null` when the reference number has no digits. Pass `detail` (from the
 * payment group's `paymentDetailFields`) when `dto.detailText` is non-blank.
 */
export function toPaymentRow(
  dto: MLGWPaymentDTO,
  propertyId: string,
  detail: PaymentDetailFields | null = null,
): MlgwPaymentRow | null {
  const referenceNumber = dto.referenceNumber.replace(/[^0-9]/g, "");
  if (referenceNumber.length === 0) return null;

  const id = makePaymentId(propertyId, referenceNumber);
  const accountNumber = normalizedAccountNumber(dto.accountNumber);

  const status = preferredPaymentValue(dto.status, detail?.status ?? null);
  const amount = parseAmount(preferredPaymentValue(dto.amount, detail?.amount ?? null));
  const paidDate = isoDateString(
    parseDate(preferredPaymentValue(dto.paidDate, detail?.paidDate ?? null)),
  );
  const paymentMethod = normalizedPaymentMethod(
    preferredPaymentValue(dto.paymentMethod, detail?.paymentMethod ?? null),
  );
  const authorizationNumber = preferredPaymentValue(
    dto.authorizationNumber,
    detail?.authorizationNumber ?? null,
  );

  return {
    id,
    mlgw_account_id: null,
    resman_property_id: propertyId,
    account_number: accountNumber,
    reference_number: referenceNumber,
    status,
    amount,
    paid_date: paidDate,
    payment_method: paymentMethod,
    authorization_number: authorizationNumber,
    account_selection: dto.accountSelection,
    detail_fetched_at: dto.detailFetchedAt !== null ? dto.detailFetchedAt.toISOString() : null,
    // The raw payment-detail page is deliberately NOT persisted: it contains the
    // cardholder name and masked PAN, and this module's contract is that no card
    // field is ever stored (the useful fields are already extracted into their
    // own columns above). `detail_text` has no downstream consumer — it is
    // withheld even from the REST API — so dropping it costs nothing.
    detail_text: "",
  };
}

/** Port of `MLGWPayment.makeId(propertyId:referenceNumber:)`. */
export function makePaymentId(propertyId: string, referenceNumber: string): string {
  const normalizedReference = referenceNumber.replace(/[^0-9]/g, "");
  if (propertyId.length === 0) return `payment|${normalizedReference}`;
  return `${propertyId}|payment|${normalizedReference}`;
}

function preferredPaymentValue(value: string, fallback: string | null): string {
  const trimmed = trimmedForCell(value);
  if (trimmed.length === 0 || looksOvercapturedPaymentValue(trimmed)) {
    return fallback !== null ? trimmedForCell(fallback) : "";
  }
  return trimmed;
}

function normalizedPaymentMethod(value: string): string {
  const trimmed = trimmedForCell(value);
  if (trimmed.length === 0) return "";
  if (trimmed.toLowerCase().includes("card")) return "Card";
  return trimmed;
}

function looksOvercapturedPaymentValue(value: string): boolean {
  const lowercased = value.toLowerCase();
  return (
    lowercased.startsWith("of payment:") ||
    lowercased.includes(" expiration date:") ||
    lowercased.includes(" name on card:") ||
    lowercased.includes(" contact information") ||
    lowercased.includes(" card billing information") ||
    lowercased.includes("$(document).ready")
  );
}

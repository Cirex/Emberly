/**
 * Port of KrakenCore/Services/MLGW/MLGWParser+ModelKeys.swift (string-derivation
 * subset).
 *
 * The stable id / document-key derivations and the service-address / amount
 * normalizers the row mappers rely on. The Swift file's SwiftData-object helpers
 * (`accountsById`, `preferredBillForDocumentKey`, `billDocumentKey(for:)`) are
 * intentionally omitted — they dedupe `@Model` instances and belong to the job
 * layer. `parseDate` delegates to `../download.parseMLGWDate`.
 */

import { parseMLGWDate } from "../download";
import type { MLGWBillDTO } from "../types";

/** Port of `normalizedAccountNumber(_:)` — digits only. */
export function normalizedAccountNumber(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/** Port of `normalizedServiceAddress(_:)`. */
export function normalizedServiceAddress(value: string): string {
  return sanitizedServiceAddress(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9# ]+/g, "");
}

/** Port of `sanitizedServiceAddress(_:)`. */
export function sanitizedServiceAddress(value: string): string {
  let cleaned = value.trim();
  cleaned = cleaned.replace(/^\s*[\d -]{4,}\s+-\s+(?=\d)/, "");
  cleaned = cleaned.replace(/\s+/g, " ");
  const first = serviceAddressPrefix(cleaned);
  if (first !== null) return first;

  cleaned = cleaned.replace(
    /\s+(?:meter\s+reader\b|previous\s+balance\b|balance\s+forward\b|readings\s+usage\s+amount\s+total\b|service\s*:).*$/i,
    "",
  );
  cleaned = cleaned.replace(/\s+/g, " ");
  return serviceAddressPrefix(cleaned) ?? cleaned.trim();
}

const SERVICE_ADDRESS_PREFIX_PATTERNS = [
  "([0-9]{1,6}\\s+[A-Za-z0-9 .'-]+?\\s+(?:Avenue|Ave|Av|Street|St|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Parkway|Pkwy|Circle|Cir|Court|Ct|Place|Pl|Way)\\b\\.?(?:\\s+(?:(?:Apt|Apartment|Unit|Ste|Suite|#)\\s*[A-Za-z0-9-]+|HSE|GHSE|LDRY|TNCT))?)",
  "([0-9]{1,6}\\s+[A-Za-z0-9 .'-]+?\\s+(?:HSE|GHSE|LDRY|TNCT))(?=\\s*(?:meter\\s+reader\\b|previous\\s+balance\\b|balance\\s+forward\\b|readings\\s+usage\\s+amount\\s+total\\b|service\\s*:|Account\\b|Acct\\b|Bill\\b|Document\\b|Due\\b|Amount\\b|\\$|[0-9][0-9-]{6,}|$))",
];

/**
 * The `MLGWParser`-scoped `serviceAddressPrefix` (distinct from the
 * whitespace-normalizing free function in `../bill-list`): it matches the
 * already-cleaned value directly.
 */
function serviceAddressPrefix(value: string): string | null {
  for (const pattern of SERVICE_ADDRESS_PREFIX_PATTERNS) {
    const match = new RegExp(pattern, "i").exec(value);
    if (match !== null && match[1] !== undefined) {
      const address = match[1].trim();
      if (address.length > 0) return address;
    }
  }
  return null;
}

/** Port of `makeAccountId(accountNumber:servicesAt:propertyId:)`. */
export function makeAccountId(
  accountNumber: string,
  servicesAt: string,
  propertyId: string,
): string {
  const normalizedAccount = normalizedAccountNumber(accountNumber);
  const serviceAddress = normalizedServiceAddress(servicesAt);
  if (normalizedAccount.length > 0) {
    return `${propertyId}|account|${normalizedAccount}|service|${serviceAddress}`;
  }
  if (serviceAddress.length > 0) {
    return `${propertyId}|service|${serviceAddress}`;
  }
  return `${propertyId}|account|unknown`;
}

/** Port of the `makeAccountId(_:propertyId:)` DTO overload. */
export function makeAccountIdFromDTO(record: MLGWBillDTO, propertyId: string): string {
  return makeAccountId(record.accountNumber, record.servicesAt, propertyId);
}

/** Port of `documentKey(propertyId:documentId:)` — `null` when the id is blank. */
export function documentKey(propertyId: string, documentId: string): string | null {
  const trimmed = documentId.trim();
  if (trimmed.length === 0) return null;
  return `${propertyId}|document|${trimmed}`;
}

/** Port of `parseAmount(_:)` (Swift `Double(cleaned)` — strict, empty → nil). */
export function parseAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/\$/g, "").replace(/,/g, "").trim();
  if (cleaned.length === 0) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Port of `isHouseAccount(servicesAt:)`. */
export function isHouseAccount(servicesAt: string): boolean {
  const suffixes = ["HSE", "GHSE", "LDRY", "TNCT"];
  const cleaned = sanitizedServiceAddress(servicesAt)
    .trim()
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+$/u, "");
  const parts = cleaned.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0);
  const suffix = parts[parts.length - 1];
  if (suffix === undefined) return false;
  return suffixes.includes(suffix);
}

/** Port of `parseDate(_:)` — delegates to `parseMLGWDate`. */
export function parseDate(value: string | null | undefined): Date | null {
  return parseMLGWDate(value ?? null);
}

/**
 * Format a parsed `Date` to the schema's `yyyy-MM-dd` (local calendar
 * components, matching `../resman/csv.normalizeCsvDate`), or `null`. The Swift
 * importers stored a `Date`; the DB date columns are ISO strings.
 */
export function isoDateString(date: Date | null): string | null {
  if (date === null) return null;
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

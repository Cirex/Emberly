/**
 * Per-row metadata extraction from bill-list row text: account number, service
 * address, amount due, due date, plus the shared `serviceAddressPrefix` helper
 * and the `targetDocumentId` resolver.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillRowMetadata.swift):
 *   metadata(from:), serviceAddressMetadata (private), serviceAddressPrefix,
 *   targetDocumentId.
 *
 * The Swift patterns carried a leading inline `(?i)`; JS `RegExp` rejects inline
 * flags, and `firstMatch` already matches case-insensitively (flags `is`), so the
 * `(?i)` prefixes are dropped here with no behavior change.
 */

import { firstMatch, trimmedForCell } from "../text";
import {
  billDocumentIdFromFields,
  billDocumentIdFromURL,
  cleanedBillDocumentId,
} from "../text";
import type { BillRowMetadata, BillTarget } from "../types";

/** Scrape `{accountNumber, address, amountDue, dueDate}` from a row's text. Port of `metadata(from:)`. */
export function metadata(rowText: string): BillRowMetadata {
  const accountNumber =
    firstMatch(rowText, String.raw`Account\s*(?:Number|No\.?|#)?\s*:?\s*([0-9][0-9-]{6,}[0-9])`) ??
    firstMatch(rowText, String.raw`\b([0-9]{8,20})\b`);
  const paymentAmount = firstMatch(
    rowText,
    String.raw`\bPayment\s+for\s+\$?\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\s+is\s+due\b`,
  );
  const paymentDueDate = firstMatch(
    rowText,
    String.raw`\bPayment\s+for\s+\$?\s*[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}\s+is\s+due\s+on\s+([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})`,
  );
  const amountDue =
    paymentAmount ??
    firstMatch(rowText, String.raw`\$?\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})`);
  const dueDate =
    paymentDueDate ?? firstMatch(rowText, String.raw`([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})`);
  const address = serviceAddressMetadata(rowText);
  return { accountNumber, address, amountDue, dueDate };
}

/** Port of the private Swift `serviceAddressMetadata(from:)`. */
function serviceAddressMetadata(rowText: string): string | null {
  const labelled = firstMatch(
    rowText,
    String.raw`Account\s*(?:Number|No\.?|#)?\s*:?\s*[0-9][0-9-]{6,}[0-9]\s*-\s*(.*?)\s*-\s*Payment\s+for\b`,
  );
  if (labelled !== null) return trimmedForCell(labelled);

  const streetSuffixPattern = String.raw`([0-9]{1,6}\s+[A-Za-z0-9 .'-]+?\s+(?:Avenue|Ave|Av|Street|St|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Parkway|Pkwy|Circle|Cir|Court|Ct|Place|Pl|Way)\b\.?(?:\s+(?:(?:Apt|Unit|Apartment|Ste|Suite|#)\s*[A-Za-z0-9-]+|HSE|GHSE|LDRY|TNCT))?)`;
  const street = firstMatch(rowText, streetSuffixPattern);
  if (street !== null) return trimmedForCell(street);

  const houseAccountPattern = String.raw`([0-9]{1,6}\s+[A-Za-z0-9 .'-]+?\s+(?:HSE|GHSE|LDRY|TNCT))(?=\s*(?:Account\b|Acct\b|Bill\b|Document\b|Due\b|Amount\b|\$|[0-9][0-9-]{6,}|$))`;
  const house = firstMatch(rowText, houseAccountPattern);
  return house === null ? null : trimmedForCell(house);
}

/**
 * The leading street-address portion of a free-text value, or `null`. Port of
 * `serviceAddressPrefix(from:)`.
 */
export function serviceAddressPrefix(value: string): string | null {
  const cleaned = trimmedForCell(value.replace(/\s+/g, " "));
  const patterns = [
    String.raw`([0-9]{1,6}\s+[A-Za-z0-9 .'-]+?\s+(?:Avenue|Ave|Av|Street|St|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Parkway|Pkwy|Circle|Cir|Court|Ct|Place|Pl|Way)\b\.?(?:\s+(?:(?:Apt|Apartment|Unit|Ste|Suite|#)\s*[A-Za-z0-9-]+|HSE|GHSE|LDRY|TNCT))?)`,
    String.raw`([0-9]{1,6}\s+[A-Za-z0-9 .'-]+?\s+(?:HSE|GHSE|LDRY|TNCT))(?=\s*(?:meter\s+reader\b|previous\s+balance\b|balance\s+forward\b|readings\s+usage\s+amount\s+total\b|service\s*:|Account\b|Acct\b|Bill\b|Document\b|Due\b|Amount\b|\$|[0-9][0-9-]{6,}|$))`,
  ];
  for (const pattern of patterns) {
    const match = firstMatch(cleaned, pattern);
    if (match !== null) {
      const trimmed = trimmedForCell(match);
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/** The bill document id for a target (id field, URL, then form fields). Port of `targetDocumentId`. */
export function targetDocumentId(target: BillTarget): string | null {
  return cleanedBillDocumentId(
    target.documentId ?? billDocumentIdFromURL(target.url) ?? billDocumentIdFromFields(target.fields),
  );
}

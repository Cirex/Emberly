/**
 * Port of KrakenCore/Services/MLGW/MLGWBillContextFields.swift.
 *
 * Harvests the account/invoice/document context for a bill row: it scans the
 * row's HTML for payment-list / account links, lifts the whitelisted query
 * params off those URLs, then backfills from the scraped row metadata (account
 * number → invoice number, due date, selectedAccount → accountSelection).
 *
 * `metadata` belongs to the bill-list group and is imported from `../bill-list`;
 * its `BillRowMetadata` return type is inferred via `ReturnType` so this module
 * does not depend on where that shared target type is finally declared (it is
 * still cross-imported between the download/bill-list groups mid-port).
 */

import { htmlLinks, queryFields } from "../text";
import { metadata } from "../bill-list";

type BillRowMetadata = ReturnType<typeof metadata>;

const ALLOWED_KEYS: Record<string, string> = {
  selectedaccount: "selectedAccount",
  accountselection: "accountSelection",
  accountnumber: "accountNumber",
  invoicenumber: "invoiceNumber",
  invoiceduedate: "invoiceDueDate",
  documentid: "documentId",
  docid: "docId",
};

/** Faithful port of `billContextFields(in:baseURL:rowText:rowMetadata:)`. */
export function billContextFields(
  sectionHTML: string,
  baseURL: URL,
  rowText: string,
  rowMetadata: BillRowMetadata | null = null,
): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const link of htmlLinks(sectionHTML, baseURL)) {
    const urlText = link.url.href.toLowerCase();
    if (
      !urlText.includes("payment-list-dialog") &&
      !urlText.includes("accountnumber=") &&
      !urlText.includes("selectedaccount=")
    ) {
      continue;
    }
    const query = queryFields(link.url);
    for (const [key, value] of Object.entries(query)) {
      const fieldKey = ALLOWED_KEYS[key.toLowerCase()];
      if (fieldKey === undefined || value.length === 0) continue;
      fields[fieldKey] = value;
    }
  }

  const meta = rowMetadata ?? metadata(rowText);
  if (meta.accountNumber != null) {
    fields["accountNumber"] = fields["accountNumber"] ?? meta.accountNumber;
    fields["invoiceNumber"] = fields["invoiceNumber"] ?? meta.accountNumber;
  }
  if (meta.dueDate != null) {
    fields["invoiceDueDate"] = fields["invoiceDueDate"] ?? meta.dueDate;
  }
  if (fields["selectedAccount"] !== undefined) {
    fields["accountSelection"] = fields["accountSelection"] ?? fields["selectedAccount"];
  }

  return fields;
}

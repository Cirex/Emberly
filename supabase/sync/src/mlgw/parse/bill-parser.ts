/**
 * Port of KrakenCore/Services/MLGW/MLGWBillParser.swift.
 *
 * Turns one `DownloadedBill` into a structured `ParsedBill` — pulling account
 * number, amounts, dates, "For"/"Services at" lines, and the full charge list.
 *
 * Deviations from Swift (brief §1/§2):
 *   - Pure: it never touches SwiftData.
 *   - No disk. Swift fell back to `billText(from: fileURL)` (reading the PDF/HTML
 *     off disk) when `extractedText` was empty; here the download layer must have
 *     already populated `extractedText` (it holds bytes in memory), so an empty
 *     `extractedText` is an error rather than a disk read.
 *   - The `FileManager` rename-to-desired-filename block is dropped (disk); the
 *     `filePath` is passed through unchanged.
 */

import type { DownloadedBill, ParsedBill } from "../types";
import { ScriptError } from "../types";
import { firstMatch, lineValue, parseDecimal, trimmedForCell } from "../text";
import { normalizedBillDate } from "../download";
import { NEWLINES } from "./charge-text";
import { averageTemperature, balanceForwardAmount, normalizedDueDate } from "./bill-field-parser";
import { cleanServiceAddress } from "./bill-address-parser";
import { parseCharges } from "./charge-parser";

/** Faithful (pure, disk-free) port of `parseBill(_:)`. */
export function parseBill(bill: DownloadedBill): ParsedBill {
  const extracted = bill.extractedText !== null ? bill.extractedText.trim() : "";
  if (extracted.length === 0) {
    // TODO(mlgw): the download layer wires the PdfTextExtractor / htmlToText seam
    // and populates `extractedText`; there is no on-disk fallback in TS.
    throw ScriptError.badResponse(
      `MLGW bill "${bill.filePath}" has no extracted text to parse.`,
    );
  }
  const text = extracted;
  const lines = text
    .split(NEWLINES)
    .map((line) => trimmedForCell(line))
    .filter((line) => line.length > 0);

  const accountNumber =
    firstMatch(text, "Account\\s*(?:Number|No\\.?|#)?\\s*[:#]?\\s*([0-9][0-9 \\-]{4,}[0-9])") ??
    bill.accountNumber ??
    "";
  const amountDueText =
    firstMatch(text, "Amount\\s*Due\\s*:?\\s*\\$?\\s*([0-9,]+\\.[0-9]{2})") ?? bill.amountDue;
  const billDate = normalizedBillDate(text);
  const balanceForward = balanceForwardAmount(text);
  const dueDate = normalizedDueDate(text, bill.dueDate);
  const billFor = lineValue("^\\s*For\\s*:?\\s*(.*)$", lines);
  const servicesAt = cleanServiceAddress(
    lineValue("^\\s*Services?\\s+at\\s*:?\\s*(.*)$", lines),
    bill.address,
  );

  return {
    documentId: bill.documentId ?? "",
    isCurrent: bill.isCurrent,
    accountNumber,
    billDate,
    amountDue: parseDecimal(amountDueText),
    balanceForward,
    averageTemperature: averageTemperature(text),
    dueDate,
    billFor,
    servicesAt,
    filePath: bill.filePath,
    charges: parseCharges(text),
  };
}

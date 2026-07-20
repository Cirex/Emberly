/**
 * Bill-list extraction diagnostics: the structured counts + first-context
 * snippets that explain why a bill-list page yielded fewer targets than the page
 * displayed, and the human-readable failure message.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillListDiagnostics.swift):
 *   BillListExtractionDiagnostics (+ its `summary`), compactHTMLDiagnosticSnippet,
 *   firstRegexContext, billLinkContext, billListExtractionDiagnostics,
 *   billListExtractionFailureMessage.
 *
 * The Swift struct's computed `summary` is modeled as a class getter so call
 * sites keep using `diagnostics.summary`. Context slicing uses UTF-16 offsets
 * (JS string indexing) rather than Swift's grapheme offsets — equivalent for
 * MLGW's ASCII markup. // TODO(mlgw): revisit if non-BMP content ever appears.
 */

import { cachedRegex, fastHTMLText, htmlDecode } from "../text";
import { metadata } from "./row-metadata";
// Assumed to live in the download sibling barrel (target-extraction group).
import { billActionPopupContexts, billListCardSections, viewDocumentCalls } from "../download";

/** Structured diagnostics for a bill-list extraction attempt. Port of the Swift struct. */
export class BillListExtractionDiagnostics {
  tableRows: number;
  billCards: number;
  menuPopupReferences: number;
  menuPopupContexts: number;
  globalViewDocumentCalls: number;
  globalBillLinks: number;
  firstViewDocumentContext: string | null;
  firstBillLinkContext: string | null;
  firstRowText: string | null;
  firstBillCardText: string | null;

  constructor(fields: {
    tableRows: number;
    billCards: number;
    menuPopupReferences: number;
    menuPopupContexts: number;
    globalViewDocumentCalls: number;
    globalBillLinks: number;
    firstViewDocumentContext: string | null;
    firstBillLinkContext: string | null;
    firstRowText: string | null;
    firstBillCardText: string | null;
  }) {
    this.tableRows = fields.tableRows;
    this.billCards = fields.billCards;
    this.menuPopupReferences = fields.menuPopupReferences;
    this.menuPopupContexts = fields.menuPopupContexts;
    this.globalViewDocumentCalls = fields.globalViewDocumentCalls;
    this.globalBillLinks = fields.globalBillLinks;
    this.firstViewDocumentContext = fields.firstViewDocumentContext;
    this.firstBillLinkContext = fields.firstBillLinkContext;
    this.firstRowText = fields.firstRowText;
    this.firstBillCardText = fields.firstBillCardText;
  }

  /** Faithful port of the Swift `summary` computed property. */
  get summary(): string {
    const parts = [
      `tableRows=${this.tableRows}`,
      `billCards=${this.billCards}`,
      `menuPopupReferences=${this.menuPopupReferences}`,
      `menuPopupContexts=${this.menuPopupContexts}`,
      `viewDocumentCalls=${this.globalViewDocumentCalls}`,
      `billLinks=${this.globalBillLinks}`,
    ];
    if (this.firstViewDocumentContext !== null) {
      parts.push(`firstViewDocument='${this.firstViewDocumentContext}'`);
    }
    if (this.firstBillLinkContext !== null) {
      parts.push(`firstBillLink='${this.firstBillLinkContext}'`);
    }
    if (this.firstRowText !== null) {
      parts.push(`firstRow='${this.firstRowText}'`);
    }
    if (this.firstBillCardText !== null) {
      parts.push(`firstBillCard='${this.firstBillCardText}'`);
    }
    return parts.join(" ");
  }
}

/** Plain-text snippet, apostrophes blanked, capped at `maxLength`. Port of `compactHTMLDiagnosticSnippet`. */
export function compactHTMLDiagnosticSnippet(value: string, maxLength = 220): string {
  const compacted = fastHTMLText(value).replace(/'/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return compacted.slice(0, maxLength) + "...";
}

/**
 * The first match of `pattern` (case-insensitive, dot-all) within decoded HTML,
 * surrounded by `contextLength` chars on each side and compacted; `null` when no
 * match. Port of `firstRegexContext`.
 */
export function firstRegexContext(html: string, pattern: string, contextLength = 160): string | null {
  const regex = cachedRegex(pattern, "is");
  const decodedHTML = htmlDecode(html);
  const match = regex.exec(decodedHTML);
  if (match === null) return null;
  const start = Math.max(0, match.index - contextLength);
  const end = Math.min(decodedHTML.length, match.index + match[0].length + contextLength);
  return compactHTMLDiagnosticSnippet(decodedHTML.slice(start, end));
}

const DIRECT_BILL_LINK_PATTERN = String.raw`<a\b[^>]*(?:href|data-href|data-url)\s*=\s*['"][^'"]*(?:ViewDocument|viewdocument|CustomerDocument|customerdocument)[^'"]*['"][^>]*>.*?</a>`;
const TEXT_BILL_LINK_PATTERN = String.raw`<a\b[^>]*>[^<]*(?:View Bill|View Invoice|View Statement)[^<]*</a>`;

/** First context around a bill-document link (URL form, then text form). Port of `billLinkContext`. */
export function billLinkContext(html: string): string | null {
  const direct = firstRegexContext(html, DIRECT_BILL_LINK_PATTERN);
  if (direct !== null) return direct;
  return firstRegexContext(html, TEXT_BILL_LINK_PATTERN);
}

/** Build the full diagnostics for a page's HTML. Port of `billListExtractionDiagnostics(in:rowCount:)`. */
export function billListExtractionDiagnostics(
  html: string,
  rowCount: number | null = null,
): BillListExtractionDiagnostics {
  const rowRegex = cachedRegex(String.raw`<tr\b[^>]*>(.*?)</tr>`, "gis");
  const rowMatches = [...html.matchAll(rowRegex)];
  const tableRows = rowCount ?? rowMatches.length;

  let firstRowText: string | null = null;
  const firstBillRow = rowMatches.find((match) => {
    const inner = match[1];
    if (inner === undefined) return false;
    const rowText = fastHTMLText(inner);
    const rowMetadata = metadata(rowText);
    return (
      rowMetadata.accountNumber !== null ||
      rowMetadata.amountDue !== null ||
      /Account/i.test(rowText) ||
      /Amount/i.test(rowText)
    );
  });
  if (firstBillRow !== undefined && firstBillRow[1] !== undefined) {
    firstRowText = compactHTMLDiagnosticSnippet(firstBillRow[1]);
  } else if (rowMatches.length > 0 && rowMatches[0][1] !== undefined) {
    firstRowText = compactHTMLDiagnosticSnippet(rowMatches[0][1]);
  }

  const billCards = billListCardSections(html);
  const popupContexts = billActionPopupContexts(html);
  const billLinkPatterns = [DIRECT_BILL_LINK_PATTERN, TEXT_BILL_LINK_PATTERN];
  const globalBillLinks = billLinkPatterns.reduce((partial, pattern) => {
    const regex = cachedRegex(pattern, "gis");
    return partial + [...html.matchAll(regex)].length;
  }, 0);

  return new BillListExtractionDiagnostics({
    tableRows,
    billCards: billCards.length,
    menuPopupReferences: billCards.filter((card) => card.menuId !== null && card.menuId !== undefined)
      .length,
    menuPopupContexts: Object.keys(popupContexts).length,
    globalViewDocumentCalls: viewDocumentCalls(html).length,
    globalBillLinks,
    firstViewDocumentContext: firstRegexContext(html, String.raw`viewDocument\s*\(`),
    firstBillLinkContext: billLinkContext(html),
    firstRowText,
    firstBillCardText: billCards.length > 0 ? billCards[0].text : null,
  });
}

/** The user-facing "short by N targets" failure message. Port of `billListExtractionFailureMessage`. */
export function billListExtractionFailureMessage(
  expectedRows: number,
  foundTargets: number,
  diagnostics: BillListExtractionDiagnostics,
): string {
  const expectedMarker =
    "Expected each bill row/card to include viewDocument(documentId, serviceNodeId), a link whose URL contains action=ViewDocument/source=CustomerDocument, or a pay_bill_header action menu with a matching menuPopupBillN document action.";
  if (foundTargets === 0) {
    return `MLGW bill list displayed ${expectedRows} row${expectedRows === 1 ? "" : "s"}, but no bill document links were found in the row HTML. ${expectedMarker} Diagnostics: ${diagnostics.summary}`;
  }
  return `MLGW bill list displayed ${expectedRows} row${expectedRows === 1 ? "" : "s"}, but only ${foundTargets} bill document link${foundTargets === 1 ? "" : "s"} were found in the row HTML. ${expectedMarker} Diagnostics: ${diagnostics.summary}`;
}

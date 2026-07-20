/**
 * MLGW bill-target extraction: turn a bill-list page (table rows or cards) into
 * the `BillTarget`s the downloader fetches, and build the Bills-Workspace
 * pagination targets.
 *
 * Ports:
 *   - MLGWViewDocumentTargets.swift     -> viewDocumentCalls, viewDocumentCall,
 *                                          viewDocumentBillTarget
 *   - MLGWRowBillLinkTargets.swift       -> rowBillLinkTarget
 *   - MLGWBillCardSections.swift         -> BillListCardSection, payBillHeaderText,
 *                                          billListCardSections
 *   - MLGWBillActionPopups.swift         -> openingTagStart, firstBillPopupStart,
 *                                          billActionPopupContexts
 *   - MLGWBillRowTargets.swift           -> billListRowTargets
 *   - MLGWBillCardTargets.swift          -> billListCardTargets
 *   - MLGWBillingWorkspaceTargets.swift  -> billingWorkspaceURL, billingWorkspaceSession,
 *                                          billingWorkspaceTargetFromSession,
 *                                          billingWorkspaceTarget, billingWorkspaceRefererURL
 *
 * Swift walked `String.Index` ranges from `NSRegularExpression`; here the ports
 * use `matchAll` with numeric string offsets (`match.index`) for the card/popup
 * slicing, and `cachedRegex` for the row/link scans.
 *
 * `ViewDocumentCall` is a download-internal DTO defined here. `billListRowTargets`
 * / `billListCardTargets` are consumed by the bill-list group's page parser
 * (`../bill-list` imports them back), and `billingWorkspaceTarget` is consumed by
 * its `loadBillTypePage` — an intentional two-way dependency between the sibling
 * modules.
 */

import type {
  BillListDocumentContext,
  BillRowMetadata,
  BillTarget,
  BillingWorkspaceSession,
  MLGWBillCollection,
} from "../types";
import { billContextFields } from "../parse";
import {
  billListDocumentContext,
  billingWorkspaceCacheBuster,
  configuredBillingPageSize,
  metadata,
} from "../bill-list";
import type { HTTPResponse, MLGWScriptCancellation } from "../types";
import {
  attributes,
  billDocumentIdFromAttributes,
  billDocumentIdFromFields,
  billDocumentIdFromURL,
  cachedRegex,
  fastHTMLText,
  firstMatch,
  htmlDecode,
  queryFields,
  resolveURL,
  trimmedForCell,
  urlBySettingQueryFields,
} from "../text";
import { inputFields } from "../session";
import { paymentListURL } from "../payment";
import { checkMLGWProcessingCancellation } from "./file-store";
import { logProfileDuration } from "./logging";

// MARK: - viewDocument(...) calls (MLGWViewDocumentTargets.swift)

/** A `viewDocument(documentId[, serviceNodeId])` JS call scraped from the markup. */
export interface ViewDocumentCall {
  documentId: string;
  serviceNodeId: string | null;
}

/** Every `viewDocument(...)` call in the (HTML-decoded) markup. Port of `viewDocumentCalls`. */
export function viewDocumentCalls(html: string): ViewDocumentCall[] {
  const decodedHTML = htmlDecode(html);
  const regex = cachedRegex(
    "viewDocument\\s*\\(\\s*['\"]?([0-9]+)['\"]?\\s*(?:,\\s*['\"]?([0-9]+)['\"]?)?",
    "gis",
  );
  const results: ViewDocumentCall[] = [];
  for (const match of decodedHTML.matchAll(regex)) {
    if (match[1] === undefined) continue;
    const serviceNodeId = match[2] !== undefined ? trimmedForCell(match[2]) : null;
    results.push({ documentId: trimmedForCell(match[1]), serviceNodeId });
  }
  return results;
}

/** The first `viewDocument(...)` call, or `null`. Port of `viewDocumentCall`. */
export function viewDocumentCall(html: string): ViewDocumentCall | null {
  return viewDocumentCalls(html)[0] ?? null;
}

/**
 * Build a GET `BillTarget` that replays the portal's `ViewDocument` action for a
 * scraped `viewDocument(...)` call. Port of `viewDocumentBillTarget`.
 */
export function viewDocumentBillTarget(
  viewDocument: ViewDocumentCall,
  actionURL: URL,
  contextFields: Record<string, string>,
  rowText: string,
  rowMetadata: BillRowMetadata,
): BillTarget {
  const fields: Record<string, string> = {
    type: "UserService",
    action: "ViewDocument",
    operation: "search",
    startPos: "0",
    source: "CustomerDocument",
    documentId: viewDocument.documentId,
  };
  for (const key of ["sessionHandle", "client"]) {
    const value = contextFields[key];
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  if (viewDocument.serviceNodeId !== null) {
    fields["accountServiceId"] = viewDocument.serviceNodeId;
  }
  fields["paymentAllowed"] = "N";

  return {
    url: urlBySettingQueryFields(actionURL, fields),
    method: "GET",
    fields: {},
    rowText,
    documentId: viewDocument.documentId,
    isCurrent: true,
    accountNumber: rowMetadata.accountNumber,
    address: rowMetadata.address,
    amountDue: rowMetadata.amountDue,
    dueDate: rowMetadata.dueDate,
    paymentListURL: null,
  };
}

// MARK: - Row bill links (MLGWRowBillLinkTargets.swift)

/**
 * The first `<a>` in a bill row/card that looks like a "view bill" / PDF link,
 * turned into a GET `BillTarget`; `null` when the row has no bill link. Port of
 * `rowBillLinkTarget`.
 */
export function rowBillLinkTarget(
  rowHTML: string,
  baseURL: URL,
  rowText: string,
  rowMetadata: BillRowMetadata,
): BillTarget | null {
  const regex = cachedRegex("<a\\b([^>]*)>(.*?)</a>", "gis");
  for (const match of rowHTML.matchAll(regex)) {
    const attrText = match[1];
    const inner = match[2];
    if (attrText === undefined || inner === undefined) continue;

    const attrs = attributes(attrText);
    const className = (attrs["class"] ?? "").toLowerCase();
    const href = attrs["data-url"] ?? attrs["data-href"] ?? attrs["href"] ?? "";
    const trimmedHref = href.trim();
    const hrefLower = trimmedHref.toLowerCase();
    const label = fastHTMLText(inner).toLowerCase().replace(/ /g, "");
    const isViewDocument =
      className.includes("view-bill") ||
      hrefLower.includes("viewdocument") ||
      hrefLower.includes("action=viewdocument") ||
      hrefLower.includes("source=customerdocument");
    const isBillLink =
      isViewDocument ||
      hrefLower.includes(".pdf") ||
      label.includes("viewbill") ||
      label.includes("viewinvoice") ||
      label.includes("viewstatement");
    if (!isBillLink) continue;
    const url = resolveURL(trimmedHref, baseURL);
    if (url === null) continue;

    const fields = billContextFields(rowHTML, baseURL, rowText, rowMetadata);
    const documentId =
      billDocumentIdFromURL(url) ??
      billDocumentIdFromFields(fields) ??
      billDocumentIdFromAttributes(attrs);
    if (trimmedHref === "#" && documentId === null) {
      continue;
    }

    return {
      url,
      method: "GET",
      fields,
      rowText,
      documentId,
      isCurrent: true,
      accountNumber: rowMetadata.accountNumber,
      address: rowMetadata.address,
      amountDue: rowMetadata.amountDue,
      dueDate: rowMetadata.dueDate,
      paymentListURL: paymentListURL(rowHTML, baseURL),
    };
  }

  return null;
}

// MARK: - Card sections (MLGWBillCardSections.swift)

/** One `pay_bill_header` card section: its HTML, header text, and popup menu id. */
export interface BillListCardSection {
  html: string;
  text: string;
  menuId: string | null;
}

/**
 * The text of the card's `pay_bill_header_b` block, falling back to the whole
 * card. Port of `payBillHeaderText`.
 */
export function payBillHeaderText(cardHTML: string): string {
  const regex = cachedRegex(
    "<div\\b(?=[^>]*\\bclass\\s*=\\s*['\"][^'\"]*\\bpay_bill_header_b\\b[^'\"]*['\"])[^>]*>(.*?)</div>",
    "is",
  );
  const match = regex.exec(cardHTML);
  if (match === null || match[1] === undefined) {
    return fastHTMLText(cardHTML);
  }
  return fastHTMLText(match[1]);
}

/**
 * Slice the page into `pay_bill_header` card sections (each running until the next
 * card or a following popup), with header text and menu id. Port of `billListCardSections`.
 */
export function billListCardSections(html: string): BillListCardSection[] {
  const regex = cachedRegex(
    "<div\\b(?=[^>]*\\bclass\\s*=\\s*['\"][^'\"]*\\bpay_bill_header\\b[^'\"]*['\"])[^>]*>",
    "gi",
  );
  const matches = [...html.matchAll(regex)];
  if (matches.length === 0) return [];

  const result: BillListCardSection[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const startLower = match.index ?? 0;
    const startUpper = startLower + match[0].length;
    const candidateEnd = index + 1 < matches.length ? (matches[index + 1].index ?? html.length) : html.length;
    const popupStart = firstBillPopupStart(html, startUpper, candidateEnd);
    const endIndex = popupStart ?? candidateEnd;
    const cardHTML = html.slice(startLower, endIndex);
    const text = payBillHeaderText(cardHTML);
    const menuId = firstMatch(cardHTML, "href\\s*=\\s*['\"]#([^'\"]+)['\"]");
    result.push({ html: cardHTML, text, menuId });
  }
  return result;
}

// MARK: - Action popups (MLGWBillActionPopups.swift)

/**
 * Walk back from `beforeIndex` (up to 300 chars) to the nearest `<`, returning its
 * index; returns `beforeIndex` unchanged when none is found. Port of `openingTagStart`.
 */
export function openingTagStart(html: string, beforeIndex: number): number {
  let cursor = beforeIndex;
  let scanned = 0;
  while (cursor > 0 && scanned < 300) {
    const previous = cursor - 1;
    if (html[previous] === "<") {
      return previous;
    }
    cursor = previous;
    scanned += 1;
  }
  return beforeIndex;
}

/**
 * The opening-tag index of the first `menuPopupBill…` element within
 * `[rangeStart, rangeEnd)`, or `null`. Port of `firstBillPopupStart`.
 */
export function firstBillPopupStart(html: string, rangeStart: number, rangeEnd: number): number | null {
  const region = html.slice(rangeStart, rangeEnd);
  const regex = cachedRegex("\\bid\\s*=\\s*['\"]menuPopupBill[0-9]+(?:-popup)?['\"]", "i");
  const match = regex.exec(region);
  if (match === null) return null;
  return openingTagStart(html, rangeStart + match.index);
}

/**
 * Map each `menuPopupBill<n>` id to the popup element's HTML (bounded to the next
 * popup or 6000 chars). Port of `billActionPopupContexts`.
 */
export function billActionPopupContexts(html: string): Record<string, string> {
  const regex = cachedRegex("\\bid\\s*=\\s*['\"](menuPopupBill[0-9]+)(?:-popup)?['\"]", "gi");
  const matches = [...html.matchAll(regex)];
  if (matches.length === 0) return {};

  const contexts: Record<string, string> = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const id = match[1];
    if (id === undefined) continue;
    const matchLower = match.index ?? 0;
    const matchUpper = matchLower + match[0].length;
    const lower = openingTagStart(html, matchLower);
    const nextLower =
      index + 1 < matches.length
        ? openingTagStart(html, matches[index + 1].index ?? html.length)
        : html.length;
    const maxUpper = Math.min(matchUpper + 6000, html.length);
    const upper = nextLower < maxUpper ? nextLower : maxUpper;
    contexts[id] = html.slice(lower, upper);
  }
  return contexts;
}

// MARK: - Row targets (MLGWBillRowTargets.swift)

/**
 * Extract `BillTarget`s from a table-row bill list. Prefers the `viewDocument(...)`
 * action target when there is document context; otherwise falls back to a row
 * bill link. Port of `billListRowTargets`.
 */
export function billListRowTargets(
  html: string,
  baseURL: URL,
  profileLabel?: string,
  cancellation?: MLGWScriptCancellation,
): BillTarget[] {
  const startedAt = profileLabel !== undefined ? Date.now() : null;
  const documentContext: BillListDocumentContext = billListDocumentContext(html, baseURL, profileLabel ?? null, "bill row");
  if (!documentContext.hasDocumentContext && profileLabel !== undefined && startedAt !== null) {
    logProfileDuration(`${profileLabel} bill row context`, startedAt, "reason=missing-session-or-client");
  }
  if (
    !documentContext.hasDocumentContext &&
    /viewDocument/i.test(html) &&
    !new RegExp(
      "href\\s*=\\s*['\"][^'\"]*(?:ViewDocument|viewdocument|CustomerDocument|customerdocument)",
      "i",
    ).test(html)
  ) {
    if (profileLabel !== undefined && startedAt !== null) {
      logProfileDuration(
        `${profileLabel} bill row extraction`,
        startedAt,
        "targets=0 reason=missing-session-or-client",
      );
    }
    return [];
  }

  const rowRegex = cachedRegex("<tr\\b[^>]*>(.*?)</tr>", "gis");
  const targets: BillTarget[] = [];
  let scannedRows = 0;
  let rowsWithViewDocument = 0;
  let rowsWithBillLinks = 0;
  let rowsWithPaymentSummary = 0;

  for (const match of html.matchAll(rowRegex)) {
    scannedRows += 1;
    if (scannedRows % 50 === 0) {
      checkMLGWProcessingCancellation(cancellation);
    }
    const rowHTML = match[1];
    if (rowHTML === undefined) continue;
    const rowText = fastHTMLText(rowHTML);
    const rowMetadata = metadata(rowText);
    const resolvedPaymentListURL = paymentListURL(rowHTML, baseURL);
    if (resolvedPaymentListURL !== null) {
      rowsWithPaymentSummary += 1;
    }

    const viewDocument = viewDocumentCall(rowHTML);
    if (viewDocument !== null && documentContext.hasDocumentContext) {
      rowsWithViewDocument += 1;
      const target = viewDocumentBillTarget(
        viewDocument,
        documentContext.actionURL,
        documentContext.fields,
        rowText,
        rowMetadata,
      );
      target.paymentListURL = resolvedPaymentListURL;
      targets.push(target);
    } else {
      const linkTarget = rowBillLinkTarget(rowHTML, baseURL, rowText, rowMetadata);
      if (linkTarget !== null) {
        rowsWithBillLinks += 1;
        targets.push(linkTarget);
      }
    }
  }

  if (profileLabel !== undefined && startedAt !== null) {
    logProfileDuration(
      `${profileLabel} bill row extraction`,
      startedAt,
      `rows=${scannedRows} rowsWithPaymentSummary=${rowsWithPaymentSummary} viewDocumentRows=${rowsWithViewDocument} linkRows=${rowsWithBillLinks} targets=${targets.length}`,
    );
  }
  return targets;
}

// MARK: - Card targets (MLGWBillCardTargets.swift)

/**
 * Extract `BillTarget`s from a card-style bill list, merging each card's action
 * popup context before scanning. Port of `billListCardTargets`.
 */
export function billListCardTargets(
  html: string,
  baseURL: URL,
  profileLabel?: string,
  cancellation?: MLGWScriptCancellation,
): BillTarget[] {
  const startedAt = profileLabel !== undefined ? Date.now() : null;
  const cards = billListCardSections(html);
  if (cards.length === 0) return [];

  const documentContext: BillListDocumentContext = billListDocumentContext(html, baseURL, profileLabel ?? null, "bill card");
  if (!documentContext.hasDocumentContext && profileLabel !== undefined && startedAt !== null) {
    logProfileDuration(`${profileLabel} bill card context`, startedAt, "reason=missing-session-or-client");
  }

  const popupContexts = billActionPopupContexts(html);
  const targets: BillTarget[] = [];
  let scannedCards = 0;
  let cardsWithViewDocument = 0;
  let cardsWithBillLinks = 0;
  let cardsWithPopup = 0;
  let cardsWithPaymentSummary = 0;

  for (const card of cards) {
    scannedCards += 1;
    if (scannedCards % 50 === 0) {
      checkMLGWProcessingCancellation(cancellation);
    }

    const rowMetadata = metadata(card.text);
    let actionHTML = card.html;
    if (card.menuId !== null) {
      const popupHTML = popupContexts[card.menuId];
      if (popupHTML !== undefined) {
        cardsWithPopup += 1;
        actionHTML += "\n" + popupHTML;
      }
    }
    const resolvedPaymentListURL = paymentListURL(actionHTML, baseURL);
    if (resolvedPaymentListURL !== null) {
      cardsWithPaymentSummary += 1;
    }

    const viewDocument = viewDocumentCall(actionHTML);
    if (viewDocument !== null && documentContext.hasDocumentContext) {
      cardsWithViewDocument += 1;
      const target = viewDocumentBillTarget(
        viewDocument,
        documentContext.actionURL,
        documentContext.fields,
        card.text,
        rowMetadata,
      );
      target.paymentListURL = resolvedPaymentListURL;
      targets.push(target);
    } else {
      const linkTarget = rowBillLinkTarget(actionHTML, baseURL, card.text, rowMetadata);
      if (linkTarget !== null) {
        cardsWithBillLinks += 1;
        targets.push(linkTarget);
      }
    }
  }

  if (profileLabel !== undefined && startedAt !== null) {
    logProfileDuration(
      `${profileLabel} bill card extraction`,
      startedAt,
      `cards=${scannedCards} popupContexts=${Object.keys(popupContexts).length} cardsWithPopup=${cardsWithPopup} cardsWithPaymentSummary=${cardsWithPaymentSummary} viewDocumentCards=${cardsWithViewDocument} linkCards=${cardsWithBillLinks} targets=${targets.length}`,
    );
  }
  return targets;
}

// MARK: - Bills-Workspace pagination targets (MLGWBillingWorkspaceTargets.swift)

/** Build a Bills-Workspace list-page URL, or `null` when `pageSize <= 0`. Port of `billingWorkspaceURL`. */
export function billingWorkspaceURL(
  session: BillingWorkspaceSession,
  collection: MLGWBillCollection,
  startPos: number,
  pageSize: number,
): URL | null {
  if (pageSize <= 0) return null;
  const url = new URL(session.serviceURL.toString());
  const params = new URLSearchParams();
  params.append("sessionHandle", session.sessionHandle);
  params.append("client", session.client);
  params.append("type", "WizardService");
  params.append("action", "Bills-Workspace");
  params.append("newBean", "");
  params.append("pageOnly", "true");
  params.append("operation", "next");
  params.append("startPos", String(startPos));
  params.append("pageSize", String(pageSize));
  params.append("accountSelection", "allActiveAccounts");
  params.append("documentSetId", collection.documentSetId);
  params.append("_", billingWorkspaceCacheBuster());
  url.search = params.toString();
  return url;
}

/**
 * Recover the Bills-Workspace session (serviceURL/sessionHandle/client) from a
 * loaded page's URL, falling back to hidden inputs. Port of `billingWorkspaceSession`.
 */
export function billingWorkspaceSession(page: HTTPResponse): BillingWorkspaceSession | null {
  const fields = queryFields(new URL(page.url));
  if ((fields["sessionHandle"] ?? "") === "" || (fields["client"] ?? "") === "") {
    const inputs = inputFields(page.text);
    for (const key of ["sessionHandle", "client"]) {
      if ((fields[key] ?? "") === "") {
        const value = inputs[key];
        if (value !== undefined && value !== "") {
          fields[key] = value;
        }
      }
    }
  }

  const sessionHandle = fields["sessionHandle"];
  const client = fields["client"];
  if (sessionHandle === undefined || sessionHandle === "" || client === undefined || client === "") {
    return null;
  }
  let serviceURL: URL;
  try {
    serviceURL = new URL("/mlg/inetSrv", page.url);
  } catch {
    return null;
  }
  return { serviceURL, sessionHandle, client };
}

/** Build a list-page `BillTarget` from a workspace session. Port of the session-based `billingWorkspaceTarget`. */
export function billingWorkspaceTargetFromSession(
  session: BillingWorkspaceSession,
  collection: MLGWBillCollection,
  startPos: number,
  pageSize: number,
): BillTarget | null {
  const url = billingWorkspaceURL(session, collection, startPos, pageSize);
  if (url === null) return null;
  return {
    url,
    method: "GET",
    fields: {},
    rowText: `${collection.displayName} list page starting at ${startPos}`,
    documentId: null,
    isCurrent: collection.isCurrent,
    accountNumber: null,
    address: null,
    amountDue: null,
    dueDate: null,
    paymentListURL: null,
  };
}

/** Build a list-page `BillTarget` directly from a loaded page. Port of the page-based `billingWorkspaceTarget`. */
export function billingWorkspaceTarget(
  page: HTTPResponse,
  collection: MLGWBillCollection,
  startPos = 0,
  pageSize: number = configuredBillingPageSize(),
): BillTarget | null {
  const session = billingWorkspaceSession(page);
  if (session === null) return null;
  return billingWorkspaceTargetFromSession(session, collection, startPos, pageSize);
}

/**
 * The Referer URL to send with a Bills-Workspace request (the `search`/`firstPage`
 * variant), or `null` when `url` is not a Bills-Workspace URL. Port of
 * `billingWorkspaceRefererURL`.
 */
export function billingWorkspaceRefererURL(url: URL): URL | null {
  const fields = queryFields(url);
  if ((fields["action"] ?? "").toLowerCase() !== "bills-workspace") {
    return null;
  }
  const params = new URLSearchParams();
  const pairs: Array<[string, string | undefined]> = [
    ["sessionHandle", fields["sessionHandle"]],
    ["client", fields["client"]],
    ["type", fields["type"] ?? "WizardService"],
    ["action", "Bills-Workspace"],
    ["operation", "search"],
    ["startPos", "0"],
    ["pageSize", fields["pageSize"]],
    ["newBean", "false"],
    ["firstPage", "true"],
  ];
  for (const [name, value] of pairs) {
    if (value !== undefined) {
      params.append(name, value);
    }
  }
  const result = new URL(url.toString());
  result.search = params.toString();
  return result;
}

/**
 * Bill-list page validation: does a fetched response actually look like the
 * requested collection's bill list, and the guard that throws when it does not.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillListValidation.swift):
 *   billListPageMatchesCollection, billListPageHasListContent, probableResponseKind,
 *   billListPageValidationError, validateBillListPage, detectedWorkspaceDocumentSet.
 *
 * `HTTPResponse` field mapping: `.statusCode` -> `.status`, `.data.isEmpty` ->
 * `.bytes.length === 0`, `.isHTML` -> `responseIsHtml(...)`, `.contentType` ->
 * `headers["content-type"] ?? ""`, `.url` (String here) -> wrapped in `new URL`.
 */

import { type HTTPResponse, ScriptError, responseIsHtml } from "../types";
import { cachedRegex, queryFields } from "../text";
import { totalItemCount } from "./counts";
// Assumed to live in the download sibling barrel.
import type { MLGWBillCollection } from "../types";
import { isBillListHTML } from "../download";

function contentTypeOf(response: HTTPResponse): string {
  return (response.headers["content-type"] ?? "").toLowerCase();
}

/** Does the page's URL carry the collection's `documentSetId`? Port of `billListPageMatchesCollection`. */
export function billListPageMatchesCollection(
  _html: string,
  url: URL,
  collection: MLGWBillCollection,
): boolean {
  return queryFields(url)["documentSetId"] === collection.documentSetId;
}

/** Does the HTML contain a bill count, bill-list markup, or a `viewDocument(` call? Port of `billListPageHasListContent`. */
export function billListPageHasListContent(html: string, _url: URL): boolean {
  return (
    totalItemCount(html) !== null ||
    isBillListHTML(html) ||
    cachedRegex(String.raw`viewDocument\s*\(`, "i").test(html)
  );
}

/** A coarse label for what a non-bill-list response probably is. Port of `probableResponseKind`. */
export function probableResponseKind(response: HTTPResponse): string {
  const lower = response.text.toLowerCase();
  if (lower.includes("samlresponse") || lower.includes("sign in") || lower.includes("login")) {
    return "login/session page";
  }
  if (lower.includes("access denied") || lower.includes("forbidden")) {
    return "access denied page";
  }
  if (
    lower.includes("an error has occurred") ||
    lower.includes("server error") ||
    lower.includes("exception") ||
    lower.includes("error page")
  ) {
    return "error page";
  }
  if (responseIsHtml(response)) {
    return "HTML page";
  }
  const contentType = contentTypeOf(response);
  return contentType.length === 0 ? "unknown response" : contentType;
}

/** The reason `response` is not a usable bill-list page, or `null` when it is. Port of `billListPageValidationError`. */
export function billListPageValidationError(
  response: HTTPResponse,
  collection: MLGWBillCollection,
): string | null {
  if (!(response.status >= 200 && response.status < 300)) {
    return `HTTP ${response.status} from ${response.url}.`;
  }
  if (response.bytes.length === 0) {
    return `empty response from ${response.url}.`;
  }
  if (!responseIsHtml(response)) {
    const contentType = contentTypeOf(response);
    return `expected an HTML bill list, got content-type '${contentType.length === 0 ? "unknown" : contentType}' from ${response.url}.`;
  }
  const url = new URL(response.url);
  if (!billListPageMatchesCollection(response.text, url, collection)) {
    const documentSet = detectedWorkspaceDocumentSet(response.text, url);
    return `expected ${collection.rawValue} bills but MLGW returned document set ${documentSet} (${probableResponseKind(response)}).`;
  }
  if (!billListPageHasListContent(response.text, url)) {
    return `response looked like ${probableResponseKind(response)} but did not contain bill rows, a bill count, or bill list controls.`;
  }
  return null;
}

/** Throw a `ScriptError.badResponse` when `response` fails validation. Port of `validateBillListPage`. */
export function validateBillListPage(
  response: HTTPResponse,
  collection: MLGWBillCollection,
  pageIndex: number,
  totalPages: number,
): void {
  const reason = billListPageValidationError(response, collection);
  if (reason !== null) {
    throw ScriptError.badResponse(
      `Could not use ${collection.rawValue} bill list page ${pageIndex} of ${totalPages}: ${reason}`,
    );
  }
}

/** The `documentSetId` MLGW actually returned, or `"unknown"`. Port of `detectedWorkspaceDocumentSet`. */
export function detectedWorkspaceDocumentSet(_html: string, url: URL): string {
  return queryFields(url)["documentSetId"] ?? "unknown";
}

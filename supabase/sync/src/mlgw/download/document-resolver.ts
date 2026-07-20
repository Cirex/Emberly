/**
 * MLGW bill-document resolution: turn a raw portal response into the response(s)
 * we parse and store. Ports MLGWBillDocumentResolver.swift.
 *
 * Handles three document shapes the FIS portal serves:
 *   - a direct PDF,
 *   - a self-contained "bill HTML" page (optionally linking a PDF), and
 *   - the CompatPresentmentService document-viewer shell, which is expanded
 *     page-by-page into synthetic bill HTML and/or a stitched `ShowPdf` PDF.
 *
 * `DocumentViewerInfo` and `BillDocumentResolution` are download-internal DTOs and
 * are defined here (the Swift kept them in a shared MLGWDocumentResolution file;
 * only the download layer consumes them).
 */

import type { BillTarget } from "../types";
import type { HTTPResponse } from "../types";
import { responseIsHtml } from "../types";
import type { MLGWHTTPClient } from "../http";
import { attributes, cachedRegex, firstMatch, resolveURL, stripTags } from "../text";

/** Extracted CompatPresentmentService viewer parameters. */
export interface DocumentViewerInfo {
  sessionHandle: string;
  client: string;
  docId: string;
  totalPages: number;
}

/** The parse/file response pair (and their provenance labels) for one document. */
export interface BillDocumentResolution {
  parseResponse: HTTPResponse;
  fileResponse: HTTPResponse;
  parseSource: string;
  fileSource: string;
}

/** `content-type` for an `HTTPResponse` (lowercased, `""` when absent). */
function contentTypeOf(response: HTTPResponse): string {
  return response.headers["content-type"] ?? "";
}

/**
 * The first `<a>` whose href/label looks like a PDF or a "view document" link,
 * resolved against `baseURL`, or `null`. Port of `pdfURLFromHTML`.
 */
export function pdfURLFromHTML(html: string, baseURL: URL): URL | null {
  const regex = cachedRegex("<a\\b([^>]*)>(.*?)</a>", "gis");
  for (const match of html.matchAll(regex)) {
    const attrText = match[1];
    const inner = match[2];
    if (attrText === undefined || inner === undefined) continue;
    const attrs = attributes(attrText);
    const label = stripTags(inner).toLowerCase();
    const href = attrs["href"] ?? "";
    const hrefLower = href.toLowerCase();
    const isRealLink = href.trim().length > 0 && href !== "#";
    if (
      isRealLink &&
      (hrefLower.includes(".pdf") ||
        label.includes("download") ||
        label.includes("pdf") ||
        (label.includes("view") && hrefLower.includes("viewdocument")))
    ) {
      return resolveURL(href, baseURL);
    }
  }
  return null;
}

/** Whether the HTML is a bill *list* page (not a single bill). Port of `isBillListHTML`. */
export function isBillListHTML(html: string): boolean {
  const lower = html.toLowerCase();
  if (lower.includes("pay_bills_form") || lower.includes("pay selected")) {
    return true;
  }
  const count = html.split("pay_bill_header_b").length - 1;
  return count > 1;
}

/** Whether the HTML is the CompatPresentmentService viewer shell. Port of `isDocumentViewerShell`. */
export function isDocumentViewerShell(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("compatpresentmentservice") &&
    lower.includes("action=showpage") &&
    lower.includes("docdisplay")
  );
}

/**
 * Extract the viewer's sessionHandle/client/docId/totalPages from the shell HTML,
 * or `null` when the required trio is missing. Port of `documentViewerInfo`.
 */
export function documentViewerInfo(html: string): DocumentViewerInfo | null {
  const sessionHandle =
    firstMatch(html, 'var\\s+sessionHandle\\s*=\\s*"([^"]+)"') ??
    firstMatch(html, 'name\\s*=\\s*"sessionHandle"\\s+value\\s*=\\s*"([^"]+)"');
  const client =
    firstMatch(html, 'var\\s+client\\s*=\\s*"([^"]+)"') ??
    firstMatch(html, 'name\\s*=\\s*"client"\\s+value\\s*=\\s*"([^"]+)"');
  const docId =
    firstMatch(html, "var\\s+docId\\s*=\\s*([0-9]+)") ??
    firstMatch(html, "<title>\\s*Show document\\s*\\[([0-9]+)\\]");
  const totalPagesText =
    firstMatch(html, "var\\s+totalPages\\s*=\\s*(?:Pages\\s*=\\s*)?([0-9]+)") ??
    firstMatch(html, "totalPages\\s*=\\s*([0-9]+)");
  if (sessionHandle === null || client === null || docId === null) return null;
  const parsedPages = Number.parseInt(totalPagesText ?? "1", 10);
  return {
    sessionHandle,
    client,
    docId,
    totalPages: Math.max(1, Number.isFinite(parsedPages) ? parsedPages : 1),
  };
}

/**
 * Build a `/mlg/inetSrv` CompatPresentmentService URL for the given action, or
 * `null`. `ShowPdf` adds `hasToc`/`endPage`; other actions add `totalPages`.
 * Port of `compatPresentmentURL`.
 */
export function compatPresentmentURL(
  baseURL: URL,
  info: DocumentViewerInfo,
  action: string,
  beginPage: number,
  endPage?: number,
): URL | null {
  let serviceURL: URL;
  try {
    serviceURL = new URL("/mlg/inetSrv", baseURL);
  } catch {
    return null;
  }
  const params = new URLSearchParams();
  params.append("type", "CompatPresentmentService");
  params.append("action", action);
  params.append("sessionHandle", info.sessionHandle);
  params.append("client", info.client);
  params.append("beginPage", String(beginPage));
  params.append("docId", info.docId);
  if (action === "ShowPdf") {
    params.append("hasToc", "false");
    params.append("endPage", String(endPage ?? info.totalPages));
  } else {
    params.append("totalPages", String(info.totalPages));
  }
  serviceURL.search = params.toString();
  return serviceURL;
}

/**
 * Fetch every viewer page, keep the ones that look like a bill, and stitch them
 * into a single synthetic bill-HTML `HTTPResponse` — or `null` when no page
 * qualifies. Port of `billHTMLFromViewer`.
 */
export async function billHTMLFromViewer(
  info: DocumentViewerInfo,
  baseURL: URL,
  client: MLGWHTTPClient,
): Promise<HTTPResponse | null> {
  const pages: string[] = [];
  for (let page = 1; page <= info.totalPages; page += 1) {
    const pageURL = compatPresentmentURL(baseURL, info, "ShowPage", page);
    if (pageURL === null) continue;
    const response = await client.request("POST", pageURL);
    const text = response.text;
    if (!(/UTILITY BILL/i.test(text) || /Amount Due/i.test(text) || /Services at/i.test(text))) {
      continue;
    }
    pages.push(`<section class="mlgw-bill-page">${text}</section>`);
  }

  if (pages.length === 0) return null;
  const html = [
    "<!doctype html>",
    "<html>",
    `<head><meta charset="utf-8"><title>MLGW Bill ${info.docId}</title></head>`,
    "<body>",
    pages.join("\n"),
    "</body>",
    "</html>",
  ].join("\n");
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    url: baseURL.toString(),
    text: html,
    bytes: new TextEncoder().encode(html),
    isPdf: false,
  };
}

/**
 * If `response` is a viewer shell, resolve it to parse/file responses (synthetic
 * bill HTML for parsing, a stitched PDF for the file when available). Returns
 * `null` when the response is not a resolvable viewer shell. Port of
 * `billDocumentResolutionFromViewerShell`.
 */
export async function billDocumentResolutionFromViewerShell(
  response: HTTPResponse,
  client: MLGWHTTPClient,
): Promise<BillDocumentResolution | null> {
  if (!responseIsHtml(response)) return null;
  const info = documentViewerInfo(response.text);
  if (info === null) return null;

  let htmlResponse: HTTPResponse | null = null;
  try {
    htmlResponse = await billHTMLFromViewer(info, new URL(response.url), client);
  } catch {
    htmlResponse = null;
  }

  let pdfResponse: HTTPResponse | undefined;
  const pdfURL = compatPresentmentURL(new URL(response.url), info, "ShowPdf", 1, info.totalPages);
  if (pdfURL !== null) {
    let resolved: HTTPResponse | undefined;
    try {
      resolved = await client.request("GET", pdfURL);
    } catch {
      resolved = undefined;
    }
    if (resolved !== undefined && resolved.isPdf) {
      pdfResponse = resolved;
    }
  }

  if (htmlResponse !== null) {
    return {
      parseResponse: htmlResponse,
      fileResponse: pdfResponse ?? htmlResponse,
      parseSource: "viewer HTML",
      fileSource: pdfResponse === undefined ? "viewer HTML" : "PDF",
    };
  }

  if (pdfResponse !== undefined) {
    return {
      parseResponse: pdfResponse,
      fileResponse: pdfResponse,
      parseSource: "PDF",
      fileSource: "PDF",
    };
  }

  return null;
}

/**
 * Heuristic: does `response` look like a single bill's HTML (as opposed to a list
 * or viewer shell)? Port of `looksLikeBillHTML`.
 */
export function looksLikeBillHTML(response: HTTPResponse, target: BillTarget): boolean {
  if (!responseIsHtml(response)) return false;
  if (isBillListHTML(response.text)) return false;
  if (isDocumentViewerShell(response.text)) return false;
  const text = stripTags(response.text).toLowerCase();
  const url = response.url.toLowerCase();
  return (
    url.includes("viewdocument") ||
    target.url.toString().toLowerCase().includes("viewdocument") ||
    (text.includes("account") && text.includes("amount") && (text.includes("due") || text.includes("services")))
  );
}

export { contentTypeOf };

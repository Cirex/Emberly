/**
 * MLGW single-bill and batch downloaders.
 *
 * Ports MLGWBillTargetDownloader.swift:
 *   - downloadBill        -> resolve one `BillTarget` to a `DownloadedBill` (or a
 *                            `BillDownloadFailure`), storing bytes via `BillFileStore`
 *   - downloadBillTargets -> bounded-concurrency batch over a collection's targets
 *
 * Adaptations:
 *   - The Swift wrote PDFs/HTML to `Invoices/`; here bytes go to an injected
 *     `BillFileStore` and `DownloadedBill.filePath` is the returned object path (brief §2).
 *   - Bill capture (Emberly addition): MLGW publishes a real PDF for only some
 *     bills. For the rest, the fetched page is turned into a SELF-CONTAINED HTML
 *     archive (`mlgw/capture`) and rendered to a PDF that actually looks like the
 *     bill. `filePath` stays PDF-only; `capturedHtmlPath` carries the archive.
 *   - Text extraction (Swift `billText(from:)`) is inlined as `billTextFromResponse`:
 *     HTML via `htmlToText`, PDF via the injected `PdfTextExtractor` (brief §3).
 *   - The `withTaskGroup` seed/drain pool becomes `mapWithConcurrency` (brief §6);
 *     per-target failures/errors are collected, not thrown, so one bad bill does
 *     not abort the batch. Result order is preserved by `mapWithConcurrency`.
 */

import type { BillRowMetadata, BillTarget, MLGWBillCollection } from "../types";
import { metadata } from "../bill-list";
import type { DownloadedBill, HTTPResponse, MLGWScriptCancellation } from "../types";
import { BillDownloadFailure, ScriptError, responseIsHtml } from "../types";
import {
  debugLog,
  formattedProfileRate,
  profileLog,
  readableErrorDescription,
} from "../env";
import type { MLGWHTTPClient } from "../http";
import { isCancellationError, mapWithConcurrency, withTransientNetworkRetries } from "../http";
import {
  billDocumentIdFromFields,
  billDocumentIdFromURL,
  cleanedBillDocumentId,
  firstMatch,
  htmlToText,
  urlByAddingQueryFields,
} from "../text";
import { formURLEncoded, parseForms, shouldAutoSubmit, submitForm } from "../session";
import type { BillFileStore, PdfTextExtractor } from "./file-store";
import { backgroundSyncConcurrency } from "./file-store";
import {
  billDocumentResolutionFromViewerShell,
  contentTypeOf,
  documentViewerInfo,
  isBillListHTML,
  looksLikeBillHTML,
  pdfURLFromHTML,
} from "./document-resolver";
import { billCaptureFilenames, normalizedBillDate } from "./filenames";
import { logProfileDuration } from "./logging";
import type { BillPdfRenderer } from "../capture";
import { buildSelfContainedDocument, describeSkippedAssets, httpAssetFetcher } from "../capture";

/**
 * How a PDF-less bill page is turned into an archive + a real PDF.
 *
 * Optional throughout: with no capture options the bill page is still archived
 * as self-contained HTML (that is the point of the archive), but no PDF is
 * rendered and the caller's transcript fallback takes over.
 */
export interface BillCaptureOptions {
  /** One browser for the whole sync run. Returns `null` when unavailable. */
  renderer?: BillPdfRenderer;
  log?: (message: string) => void;
  /** Skip any single asset above this size (default 5 MiB). */
  maxAssetBytes?: number;
  /** Stop inlining once this much asset data is embedded (default 24 MiB). */
  maxDocumentBytes?: number;
}

/** UTF-8 encoder for the archived HTML bytes. */
const utf8 = new TextEncoder();

/** `n` with thousands grouping (Swift `Int.formatted()`). */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** The parent-directory URL string for a Referer header. Port of `URL.deletingLastPathComponent().absoluteString`. */
function deletingLastPathComponent(url: URL): string {
  const parent = new URL(url.toString());
  parent.search = "";
  parent.hash = "";
  const segments = parent.pathname.split("/");
  segments.pop();
  let path = segments.join("/");
  if (!path.endsWith("/")) path += "/";
  parent.pathname = path;
  return parent.toString();
}

/**
 * The row metadata for a target: its own account/address/amount/dueDate fields
 * when any are set, else parsed from `rowText`. Port of the Swift
 * `BillTarget.rowMetadata` computed property.
 */
function billTargetRowMetadata(target: BillTarget): BillRowMetadata {
  if (
    target.accountNumber !== null ||
    target.address !== null ||
    target.amountDue !== null ||
    target.dueDate !== null
  ) {
    return {
      accountNumber: target.accountNumber,
      address: target.address,
      amountDue: target.amountDue,
      dueDate: target.dueDate,
    };
  }
  return metadata(target.rowText);
}

/** HTML -> text via `htmlToText`, PDF -> text via the injected extractor. Inlined `billText(from:)`. */
async function billTextFromResponse(
  response: HTTPResponse,
  pdfExtractor: PdfTextExtractor,
): Promise<string> {
  if (responseIsHtml(response)) {
    return htmlToText(response.text);
  }
  return pdfExtractor.extractText(response.bytes);
}

/** `billTextFromResponse` swallowing errors to `""` (Swift `(try? billText(...)) ?? ""`). */
async function safeBillText(response: HTTPResponse, pdfExtractor: PdfTextExtractor): Promise<string> {
  try {
    return await billTextFromResponse(response, pdfExtractor);
  } catch {
    return "";
  }
}

/**
 * Resolve and download a single bill target: follow viewer shells / auto-submit
 * forms / PDF links, store the file bytes, extract text, and return a
 * `DownloadedBill` — or a `BillDownloadFailure` when nothing bill-like came back.
 * Port of `downloadBill`.
 */
export async function downloadBill(
  target: BillTarget,
  client: MLGWHTTPClient,
  fileStore: BillFileStore,
  pdfExtractor: PdfTextExtractor,
  index: number,
  cancellation?: MLGWScriptCancellation,
  capture?: BillCaptureOptions,
): Promise<DownloadedBill | BillDownloadFailure> {
  cancellation?.check();
  let response: HTTPResponse;
  let parseResponse: HTTPResponse | undefined;
  let fileResponse: HTTPResponse | undefined;
  let parseSource = "initial response";
  let fileSource = "initial response";
  let documentId: string | null =
    target.documentId ?? billDocumentIdFromURL(target.url) ?? billDocumentIdFromFields(target.fields);

  if (target.method === "GET") {
    response = await client.request("GET", target.url, {
      headers: { Referer: deletingLastPathComponent(target.url) },
    });
    if (responseIsHtml(response) && isBillListHTML(response.text) && Object.keys(target.fields).length > 0) {
      const contextualURL = urlByAddingQueryFields(target.url, target.fields);
      response = await client.request("GET", contextualURL, {
        headers: { Referer: deletingLastPathComponent(target.url) },
      });
    }
  } else {
    response = await client.request("POST", target.url, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formURLEncoded(target.fields),
    });
  }

  for (let iteration = 0; iteration < 6; iteration += 1) {
    cancellation?.check();
    if (documentId === null) {
      documentId = billDocumentIdFromURL(new URL(response.url));
    }
    if (documentId === null && responseIsHtml(response)) {
      const viewerInfo = documentViewerInfo(response.text);
      if (viewerInfo !== null) {
        documentId = viewerInfo.docId;
      }
    }
    if (response.isPdf) {
      parseResponse = response;
      fileResponse = response;
      parseSource = "PDF";
      fileSource = "PDF";
      break;
    }
    const resolution = await billDocumentResolutionFromViewerShell(response, client);
    if (resolution !== null) {
      parseResponse = resolution.parseResponse;
      fileResponse = resolution.fileResponse;
      parseSource = resolution.parseSource;
      fileSource = resolution.fileSource;
      if (documentId === null) {
        const viewerInfo = documentViewerInfo(response.text);
        if (viewerInfo !== null) {
          documentId = viewerInfo.docId;
        }
      }
      break;
    }
    const forms = parseForms(response.text, new URL(response.url));
    const form = forms.find(shouldAutoSubmit);
    if (form !== undefined) {
      response = await submitForm(client, form);
      continue;
    }
    if (looksLikeBillHTML(response, target)) {
      parseResponse = response;
      parseSource = "bill HTML";
      const pdfURL = pdfURLFromHTML(response.text, new URL(response.url));
      let usedPdf = false;
      if (pdfURL !== null) {
        let pdfResponse: HTTPResponse | undefined;
        try {
          pdfResponse = await client.request("GET", pdfURL);
        } catch {
          pdfResponse = undefined;
        }
        if (pdfResponse !== undefined && pdfResponse.isPdf) {
          fileResponse = pdfResponse;
          fileSource = "PDF";
          usedPdf = true;
        }
      }
      if (!usedPdf) {
        fileResponse = response;
        fileSource = "bill HTML";
      }
      break;
    }
    const pdfURL = pdfURLFromHTML(response.text, new URL(response.url));
    if (pdfURL !== null) {
      response = await client.request("GET", pdfURL);
      continue;
    }
    break;
  }

  const resolvedParseResponse = parseResponse ?? response;
  const resolvedFileResponse = fileResponse ?? response;

  if (
    !(
      resolvedParseResponse.isPdf ||
      resolvedFileResponse.isPdf ||
      looksLikeBillHTML(resolvedParseResponse, target) ||
      looksLikeBillHTML(resolvedFileResponse, target)
    )
  ) {
    const debugResponse = parseResponse ?? fileResponse ?? response;
    return new BillDownloadFailure(
      index,
      debugResponse.url,
      debugResponse.status,
      contentTypeOf(debugResponse),
    );
  }

  const row = billTargetRowMetadata(target);
  let responseText = await safeBillText(resolvedParseResponse, pdfExtractor);
  if (
    responseText.trim().length === 0 &&
    (resolvedParseResponse.url !== resolvedFileResponse.url ||
      contentTypeOf(resolvedParseResponse) !== contentTypeOf(resolvedFileResponse))
  ) {
    responseText = await safeBillText(resolvedFileResponse, pdfExtractor);
    if (responseText.trim().length !== 0) {
      parseSource = `${fileSource} text`;
    }
  }

  const contentAccountNumber = firstMatch(
    responseText,
    "Account\\s*(?:Number|No\\.?|#)?\\s*[:#]?\\s*([0-9][0-9 \\-]{4,}[0-9])",
  );
  const billDateForFilename = normalizedBillDate(responseText, row.dueDate);
  const accountForFilename = contentAccountNumber ?? row.accountNumber ?? "";
  const names = billCaptureFilenames(
    billDateForFilename,
    accountForFilename,
    documentId,
    `mlgw-bill-${index + 1}`,
  );

  // `filePath` is the INVOICE and is only ever a PDF. MLGW's own PDF wins
  // outright (unchanged behaviour); otherwise the bill page is captured as
  // self-contained HTML — archived either way — and rendered to a PDF that
  // actually looks like the bill. When rendering is unavailable, `filePath`
  // stays "" and the bills job falls back to the text-transcript PDF.
  let destination = "";
  let capturedHtmlPath = "";
  let captureSource = fileSource;
  if (resolvedFileResponse.isPdf) {
    destination = await fileStore.put(names.pdf, resolvedFileResponse.bytes, "application/pdf");
  } else {
    const log = capture?.log ?? debugLog;
    const document = await buildSelfContainedDocument(
      resolvedFileResponse.text,
      resolvedFileResponse.url,
      httpAssetFetcher(client, resolvedFileResponse.url),
      { maxAssetBytes: capture?.maxAssetBytes, maxDocumentBytes: capture?.maxDocumentBytes },
    );
    if (document.skipped.length > 0) {
      log(
        `[mlgw-bills] bill ${index + 1}: omitted ${document.skipped.length} asset(s) from the capture — ${describeSkippedAssets(document.skipped)}`,
      );
    }
    capturedHtmlPath = await fileStore.put(names.html, utf8.encode(document.html), "text/html");
    const rendered = (await capture?.renderer?.render(document.html)) ?? null;
    if (rendered !== null) {
      destination = await fileStore.put(names.pdf, rendered, "application/pdf");
      captureSource = "rendered bill page";
    }
  }

  const trimmedResponseText = responseText.trim();
  debugLog(
    `Bill ${index + 1} ${cleanedBillDocumentId(documentId) ?? "unknown document"}: parse source ${parseSource}, saved invoice source ${captureSource}.`,
  );

  return {
    documentId: cleanedBillDocumentId(documentId),
    isCurrent: target.isCurrent,
    accountNumber: row.accountNumber,
    address: row.address,
    amountDue: row.amountDue,
    dueDate: row.dueDate,
    rowText: target.rowText,
    filePath: destination,
    capturedHtmlPath,
    extractedText: trimmedResponseText.length === 0 ? null : trimmedResponseText,
    parseSource,
  };
}

type BillTaskResult =
  | { kind: "downloaded"; bill: DownloadedBill }
  | { kind: "failure"; failure: BillDownloadFailure }
  | { kind: "error"; index: number; error: unknown }
  | { kind: "cancelled" };

/**
 * Download a collection's targets with bounded concurrency, collecting failures
 * and errors rather than aborting. Throws only when nothing downloaded and at
 * least one target failed/errored. Port of `downloadBillTargets`.
 */
export async function downloadBillTargets(
  targets: BillTarget[],
  collection: MLGWBillCollection,
  client: MLGWHTTPClient,
  fileStore: BillFileStore,
  pdfExtractor: PdfTextExtractor,
  requestedWorkerCount?: number | null,
  cancellation?: MLGWScriptCancellation,
  progress?: (message: string) => void,
  capture?: BillCaptureOptions,
): Promise<DownloadedBill[]> {
  if (targets.length === 0) return [];

  const downloadProfileStartedAt = Date.now();
  const workerCount = Math.min(backgroundSyncConcurrency(requestedWorkerCount ?? undefined), targets.length);
  progress?.(
    `${collection.displayName}: opening ${fmt(targets.length)} bill${targets.length === 1 ? "" : "s"} with ${workerCount} worker${workerCount === 1 ? "" : "s"}`,
  );
  debugLog(`${collection.displayName}: downloading ${targets.length} bill target(s) with ${workerCount} worker(s).`);
  profileLog(`${collection.displayName} bill open setup | targets=${targets.length} workers=${workerCount}`);

  const total = targets.length;
  const reportStep = Math.max(1, Math.min(50, Math.floor(total / 20)));
  let downloadedCount = 0;
  let skippedCount = 0;

  const outcomes = await mapWithConcurrency(targets, workerCount, async (target, idx): Promise<BillTaskResult> => {
    const workerClient = client.copyForConcurrentRequests();
    let result: BillTaskResult;
    try {
      cancellation?.check();
      const downloadResult = await withTransientNetworkRetries(
        () => downloadBill(target, workerClient, fileStore, pdfExtractor, idx, cancellation, capture),
        { cancellation },
      );
      result =
        downloadResult instanceof BillDownloadFailure
          ? { kind: "failure", failure: downloadResult }
          : { kind: "downloaded", bill: downloadResult };
    } catch (error) {
      result = isCancellationError(error) ? { kind: "cancelled" } : { kind: "error", index: idx, error };
    }

    if (result.kind === "downloaded") {
      downloadedCount += 1;
    } else if (result.kind === "failure" || result.kind === "error") {
      skippedCount += 1;
    }
    if (result.kind !== "cancelled") {
      const processed = downloadedCount + skippedCount;
      if (processed === 1 || processed === total || processed % reportStep === 0) {
        progress?.(
          `${collection.displayName}: Processed ${fmt(processed)} of ${fmt(total)} bills (${fmt(downloadedCount)} downloaded, ${fmt(skippedCount)} skipped)`,
        );
      }
    }
    return result;
  });

  cancellation?.check();

  // `mapWithConcurrency` preserves input order, so filtering keeps bill-list order.
  const downloaded: DownloadedBill[] = [];
  const failures: BillDownloadFailure[] = [];
  const errors: Array<{ index: number; error: unknown }> = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "downloaded") downloaded.push(outcome.bill);
    else if (outcome.kind === "failure") failures.push(outcome.failure);
    else if (outcome.kind === "error") errors.push({ index: outcome.index, error: outcome.error });
  }

  if (downloaded.length === 0 && failures.length > 0) {
    const firstFailure = failures[0];
    throw ScriptError.badResponse(
      `${collection.rawValue} bill targets were found, but none returned bill files. First response: HTTP ${firstFailure.statusCode}, content-type '${firstFailure.contentType}', URL ${firstFailure.url}.`,
    );
  }
  if (downloaded.length === 0 && errors.length > 0) {
    const firstError = errors[0];
    throw ScriptError.badResponse(
      `Could not download ${collection.rawValue} bill ${firstError.index + 1} of ${total}: ${readableErrorDescription(firstError.error)}`,
    );
  }
  if (failures.length > 0) {
    debugLog(
      `${collection.displayName}: downloaded ${downloaded.length} bill file(s); ${failures.length} target(s) did not return bill files. First failed URL ${failures[0].url}.`,
    );
  }
  if (errors.length > 0) {
    debugLog(
      `${collection.displayName}: downloaded ${downloaded.length} bill file(s); ${errors.length} target(s) failed. First error from target ${errors[0].index + 1}: ${readableErrorDescription(errors[0].error)}`,
    );
  }
  debugLog(
    `${collection.displayName}: downloaded ${downloaded.length} bill file(s); skipped ${failures.length + errors.length}.`,
  );
  const wallElapsed = logProfileDuration(
    `${collection.displayName} bill open wall time`,
    downloadProfileStartedAt,
    `downloaded=${downloaded.length} skipped=${failures.length + errors.length} workers=${workerCount}`,
  );
  profileLog(
    `${collection.displayName} bill open rate | ${formattedProfileRate(downloaded.length, wallElapsed)}`,
  );
  // Capture accounting: how many PDF-less bills were archived as self-contained
  // HTML, and how many of those also produced a rendered PDF. A large gap means
  // the renderer is unavailable and bills are getting text transcripts.
  const archived = downloaded.filter((bill) => (bill.capturedHtmlPath ?? "").length > 0);
  const rendered = archived.filter((bill) => bill.filePath.length > 0).length;
  if (archived.length > 0) {
    progress?.(
      `${collection.displayName}: archived ${fmt(archived.length)} bill page capture${archived.length === 1 ? "" : "s"}, rendered ${fmt(rendered)} to PDF`,
    );
  }
  progress?.(
    `${collection.displayName}: downloaded ${fmt(downloaded.length)} bill file${downloaded.length === 1 ? "" : "s"}`,
  );
  return downloaded;
}

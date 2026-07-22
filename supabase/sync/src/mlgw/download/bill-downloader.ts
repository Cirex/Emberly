/**
 * MLGW background bill/payment download workflows — the download layer's entry
 * points. Ports MLGWBillDownloader.swift:
 *   - downloadBillsInBackground    -> SSO, portal, Current+Archived bill download
 *   - downloadPaymentsInBackground -> SSO, portal, list scrape, payment scrape
 *
 * Adaptations:
 *   - Positional Swift parameters become an options object (idiomatic TS).
 *   - The Swift `invoicesURL` disk directory is gone; callers may inject a
 *     `BillFileStore` (default `InMemoryBillFileStore`) and a `PdfTextExtractor`
 *     (default `UnimplementedPdfTextExtractor`) (brief §2/§3). A single file store
 *     is shared across both collection passes for cross-pass filename dedupe.
 *   - `cancellation?.check()` replaces `try cancellation?.check()` (brief §7).
 */

import { MLGWBillCollection } from "../types";
import { mergedBillDocumentStatuses } from "../bill-list";
import type {
  DownloadedBill,
  BillListDocumentMetadata,
  MLGWDownloadResult,
  MLGWPaymentDownloadResult,
  MLGWScriptCancellation,
} from "../types";
import { BackgroundSyncWorkerConfiguration, ScriptError } from "../types";
import { MLGWHTTPClient } from "../http";
import { debugLog, debugStage } from "../env";
import { cleanedBillDocumentId } from "../text";
import { establishSsoSession, openBillingPortal } from "../session";
import { collectPayments, uniquePaymentListTargets } from "../payment";
import type { BillFileStore, PdfTextExtractor } from "./file-store";
import { InMemoryBillFileStore, UnimplementedPdfTextExtractor } from "./file-store";
import { collectBillCollectionDownload, downloadUnsyncedBillTargets } from "./collection-download";
import type { BillCaptureOptions } from "./target-downloader";
import { logProfileDuration, logStageDuration } from "./logging";
import type { BillPdfRenderer } from "../capture";
import { createBillPdfRenderer } from "../capture";

/** `n` with thousands grouping (Swift `Int.formatted()`). */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Options for `downloadBillsInBackground`. */
export interface DownloadBillsOptions {
  username: string;
  password: string;
  backgroundSyncWorkerCount?: number;
  knownDocumentIds?: Set<string>;
  cancellation?: MLGWScriptCancellation;
  /** Byte sink for downloaded bills (default `InMemoryBillFileStore`). */
  fileStore?: BillFileStore;
  /** PDF text extractor (default `UnimplementedPdfTextExtractor`, HTML still parses). */
  pdfExtractor?: PdfTextExtractor;
  /** HTTP client override (default a fresh `MLGWHTTPClient`). */
  client?: MLGWHTTPClient;
  /** Optional sink for scraped list-row metadata, invoked per collection. */
  listMetadataHandler?: (rows: BillListDocumentMetadata[]) => Promise<void>;
  /**
   * HTML→PDF renderer for bills MLGW publishes no PDF for. Default: one system
   * Chromium launched lazily for this run and closed before returning. Pass
   * `UnavailableBillPdfRenderer` to disable rendering (bills still get their
   * self-contained HTML archive, and the job falls back to a text transcript).
   */
  renderer?: BillPdfRenderer;
  progress?: (message: string) => void;
}

/** Options for `downloadPaymentsInBackground`. */
export interface DownloadPaymentsOptions {
  username: string;
  password: string;
  backgroundSyncWorkerCount?: number;
  cancellation?: MLGWScriptCancellation;
  client?: MLGWHTTPClient;
  progress?: (message: string) => void;
}

/**
 * Sign in, open the billing portal, and download Current + Archived bills (skipping
 * already-known documents), returning DTOs + document statuses. Port of
 * `downloadBillsInBackground`.
 */
export async function downloadBillsInBackground(
  options: DownloadBillsOptions,
): Promise<MLGWDownloadResult> {
  // ONE browser for the whole run: launching per bill would add process startup
  // to each of thousands of bills. It is launched lazily on the first PDF-less
  // bill and always closed here, even when the download throws.
  const ownsRenderer = options.renderer === undefined;
  const renderer =
    options.renderer ?? createBillPdfRenderer({ log: options.progress ?? ((m: string) => debugLog(m)) });
  try {
    return await runBillDownload(options, renderer);
  } finally {
    if (ownsRenderer) await renderer.close();
  }
}

async function runBillDownload(
  options: DownloadBillsOptions,
  renderer: BillPdfRenderer,
): Promise<MLGWDownloadResult> {
  const { username, password } = options;
  const backgroundSyncWorkerCount =
    options.backgroundSyncWorkerCount ?? BackgroundSyncWorkerConfiguration.defaultWorkerCount;
  const knownDocumentIds = options.knownDocumentIds ?? new Set<string>();
  const cancellation = options.cancellation;
  const fileStore = options.fileStore ?? new InMemoryBillFileStore();
  const pdfExtractor = options.pdfExtractor ?? new UnimplementedPdfTextExtractor();
  const client = options.client ?? new MLGWHTTPClient();
  const progress = options.progress;
  const listMetadataHandler = options.listMetadataHandler;
  const capture: BillCaptureOptions = { renderer, log: progress ?? ((m: string) => debugLog(m)) };

  const totalStartedAt = Date.now();
  debugStage(
    "MLGW bill download workflow started",
    `workers=${backgroundSyncWorkerCount} knownDocuments=${knownDocumentIds.size}`,
  );

  cancellation?.check();
  const signInStartedAt = Date.now();
  progress?.("Signing in to My MLGW");
  debugStage("MLGW sign-in started");
  debugLog("Opening MLGW/FIS billing session in the background via SSO.");
  await establishSsoSession(client, username, password);
  logStageDuration("MLGW sign-in", signInStartedAt);

  cancellation?.check();
  const portalStartedAt = Date.now();
  progress?.("Loading billing portal home");
  debugStage("Billing portal load started");
  const billingHome = await openBillingPortal(client);
  debugLog(`Billing portal home loaded from ${billingHome.url}.`);
  logStageDuration("Billing portal load", portalStartedAt);

  // The two collection passes (list-page fetch + parse) are independent, so run
  // them concurrently on separate client copies. The *downloads* stay ordered:
  // the archived pass skips documents downloaded during the current pass.
  const [currentBills, archivedBills] = await Promise.all([
    collectBillCollectionDownload(
      MLGWBillCollection.current,
      billingHome,
      client.copyForConcurrentRequests(),
      backgroundSyncWorkerCount,
      cancellation,
      listMetadataHandler,
      progress,
    ),
    collectBillCollectionDownload(
      MLGWBillCollection.archived,
      billingHome,
      client.copyForConcurrentRequests(),
      backgroundSyncWorkerCount,
      cancellation,
      listMetadataHandler,
      progress,
    ),
  ]);

  if (currentBills.targets.length === 0 && archivedBills.targets.length === 0) {
    throw ScriptError.noBillsDownloaded();
  }

  let downloaded: DownloadedBill[] = [];
  let skippedKnownDocuments = 0;
  const currentBatch = await downloadUnsyncedBillTargets(
    currentBills.targets,
    MLGWBillCollection.current,
    client,
    fileStore,
    pdfExtractor,
    knownDocumentIds,
    backgroundSyncWorkerCount,
    "whose document IDs already exist locally.",
    cancellation,
    progress,
    capture,
  );
  downloaded = downloaded.concat(currentBatch.downloaded);
  skippedKnownDocuments += currentBatch.skippedKnownDocuments;

  const documentStatuses = mergedBillDocumentStatuses([
    ...currentBills.artifacts.statuses,
    ...archivedBills.artifacts.statuses,
  ]);
  const totalListMetadataCount =
    currentBills.artifacts.metadata.length + archivedBills.artifacts.metadata.length;

  const downloadedDocumentIds = new Set<string>();
  for (const bill of downloaded) {
    const cleaned = cleanedBillDocumentId(bill.documentId);
    if (cleaned !== null) downloadedDocumentIds.add(cleaned);
  }
  const archivedKnownDocumentIds = new Set<string>([...knownDocumentIds, ...downloadedDocumentIds]);
  const archivedBatch = await downloadUnsyncedBillTargets(
    archivedBills.targets,
    MLGWBillCollection.archived,
    client,
    fileStore,
    pdfExtractor,
    archivedKnownDocumentIds,
    backgroundSyncWorkerCount,
    "whose document IDs already exist locally or were downloaded during the current pass.",
    cancellation,
    progress,
    capture,
  );
  downloaded = downloaded.concat(archivedBatch.downloaded);
  skippedKnownDocuments += archivedBatch.skippedKnownDocuments;

  progress?.(
    `Downloaded ${fmt(downloaded.length)} bill file${downloaded.length === 1 ? "" : "s"} across Current Bills and Archived Bills`,
  );
  debugStage(
    "MLGW bill download workflow finished",
    `downloaded=${downloaded.length} statuses=${documentStatuses.length} metadataRows=${totalListMetadataCount}`,
  );
  logStageDuration("MLGW bill download workflow", totalStartedAt);
  return {
    downloadedBills: downloaded,
    documentStatuses,
    payments: [],
    downloadedDocuments: downloaded.length,
    skippedKnownDocuments,
  };
}

/**
 * Sign in, open the billing portal, scrape both collections' bill rows for payment
 * summary links, then scrape those payment histories. Port of `downloadPaymentsInBackground`.
 */
export async function downloadPaymentsInBackground(
  options: DownloadPaymentsOptions,
): Promise<MLGWPaymentDownloadResult> {
  const { username, password } = options;
  const backgroundSyncWorkerCount =
    options.backgroundSyncWorkerCount ?? BackgroundSyncWorkerConfiguration.defaultWorkerCount;
  const cancellation = options.cancellation;
  const client = options.client ?? new MLGWHTTPClient();
  const progress = options.progress;

  const totalStartedAt = Date.now();
  debugStage("MLGW payment download workflow started", `workers=${backgroundSyncWorkerCount}`);

  cancellation?.check();
  const signInStartedAt = Date.now();
  progress?.("Signing in to My MLGW");
  debugStage("MLGW payment sign-in started");
  await establishSsoSession(client, username, password);
  logStageDuration("MLGW payment sign-in", signInStartedAt);

  cancellation?.check();
  const portalStartedAt = Date.now();
  progress?.("Loading billing portal home");
  const billingHome = await openBillingPortal(client);
  logStageDuration("MLGW payment portal load", portalStartedAt);

  // Both collection passes only feed uniquePaymentListTargets afterward, so they
  // are fully independent — run them concurrently on separate client copies.
  const [currentBills, archivedBills] = await Promise.all([
    collectBillCollectionDownload(
      MLGWBillCollection.current,
      billingHome,
      client.copyForConcurrentRequests(),
      backgroundSyncWorkerCount,
      cancellation,
      undefined,
      progress,
    ),
    collectBillCollectionDownload(
      MLGWBillCollection.archived,
      billingHome,
      client.copyForConcurrentRequests(),
      backgroundSyncWorkerCount,
      cancellation,
      undefined,
      progress,
    ),
  ]);

  const paymentStartedAt = Date.now();
  const paymentTargets = uniquePaymentListTargets([...currentBills.targets, ...archivedBills.targets]);
  if (paymentTargets.length === 0) {
    progress?.("MLGW payments: no payment summary links were found on the bill rows");
    debugStage(
      "MLGW payment target extraction found no links",
      `billTargets=${currentBills.targets.length + archivedBills.targets.length} currentTargets=${currentBills.targets.length} archivedTargets=${archivedBills.targets.length}`,
    );
  } else {
    progress?.(
      `MLGW payments: found ${fmt(paymentTargets.length)} payment summary link${paymentTargets.length === 1 ? "" : "s"}`,
    );
  }
  const payments = await collectPayments(
    paymentTargets,
    client,
    backgroundSyncWorkerCount,
    cancellation,
    progress,
  );
  logProfileDuration(
    "MLGW payment scrape",
    paymentStartedAt,
    `targets=${paymentTargets.length} payments=${payments.length}`,
  );

  progress?.(`Downloaded ${fmt(payments.length)} MLGW payment${payments.length === 1 ? "" : "s"}`);
  debugStage(
    "MLGW payment download workflow finished",
    `targets=${paymentTargets.length} payments=${payments.length}`,
  );
  logStageDuration("MLGW payment download workflow", totalStartedAt);
  return { payments, paymentTargets: paymentTargets.length };
}

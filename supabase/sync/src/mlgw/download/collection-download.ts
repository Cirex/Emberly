/**
 * MLGW per-collection (Current / Archived) download orchestration.
 *
 * Ports MLGWBillCollectionDownload.swift:
 *   - collectBillCollectionDownload -> load a collection's list page, collect its
 *     `BillTarget`s, and build+save its list artifacts (statuses/metadata)
 *   - downloadUnsyncedBillTargets   -> filter out known documents, then download
 *   - buildAndSaveBillListArtifacts  -> build artifacts, optionally hand metadata off
 *
 * The Swift created a fresh `BillFileStore` inside `downloadBillTargets`; here a
 * single injected `BillFileStore` (+ `PdfTextExtractor`) is threaded through so
 * the in-memory store de-duplicates filenames across the Current and Archived
 * passes, matching the Swift filesystem-level dedupe.
 */

import type { BillListArtifacts } from "../bill-list";
import type { BillTarget, MLGWBillCollection } from "../types";
import {
  billListArtifacts,
  collectBillTargets,
  filterKnownBillTargets,
  loadBillTypePage,
} from "../bill-list";
import type {
  BillListDocumentMetadata,
  DownloadedBill,
  HTTPResponse,
  MLGWScriptCancellation,
} from "../types";
import type { MLGWHTTPClient } from "../http";
import { debugLog, debugStage } from "../env";
import type { BillFileStore, PdfTextExtractor } from "./file-store";
import type { BillCaptureOptions } from "./target-downloader";
import { downloadBillTargets } from "./target-downloader";
import { logProfileDuration, logStageDuration } from "./logging";

/** A collection's collected targets plus its list artifacts. Port of `MLGWBillCollectionDownload`. */
export interface MLGWBillCollectionDownload {
  targets: BillTarget[];
  artifacts: BillListArtifacts;
}

/** The result of downloading a collection's unsynced targets. Port of `MLGWBillDownloadBatch`. */
export interface MLGWBillDownloadBatch {
  downloaded: DownloadedBill[];
  skippedKnownDocuments: number;
}

/** `n` with thousands grouping (Swift `Int.formatted()`). */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Load a collection's list page, collect its bill-row targets, and build (and,
 * when a handler is given, save) its list artifacts. Port of `collectBillCollectionDownload`.
 */
export async function collectBillCollectionDownload(
  collection: MLGWBillCollection,
  billingHome: HTTPResponse,
  client: MLGWHTTPClient,
  backgroundSyncWorkerCount: number,
  cancellation: MLGWScriptCancellation | undefined,
  listMetadataHandler: ((rows: BillListDocumentMetadata[]) => Promise<void>) | undefined,
  progress: ((message: string) => void) | undefined,
): Promise<MLGWBillCollectionDownload> {
  cancellation?.check();
  const collectionStartedAt = Date.now();
  progress?.(`${collection.displayName}: loading list`);
  debugStage(`${collection.displayName}: loading list`);
  const page = await loadBillTypePage(collection, billingHome, client, cancellation, progress);

  progress?.(`${collection.displayName}: reading list rows`);
  debugStage(`${collection.displayName}: reading list rows`, `bytes=${page.bytes.length}`);
  const targets = await collectBillTargets(
    page,
    client,
    collection,
    cancellation,
    backgroundSyncWorkerCount,
    progress,
  );
  logStageDuration(`${collection.displayName} list row collection`, collectionStartedAt);
  progress?.(`${collection.displayName}: collected ${fmt(targets.length)} bill row${targets.length === 1 ? "" : "s"}`);

  const artifacts = await buildAndSaveBillListArtifacts(
    targets,
    collection,
    cancellation,
    listMetadataHandler,
    progress,
  );
  return { targets, artifacts };
}

/**
 * Filter out targets whose document ids are already known, then download the rest.
 * Port of `downloadUnsyncedBillTargets`.
 */
export async function downloadUnsyncedBillTargets(
  targets: BillTarget[],
  collection: MLGWBillCollection,
  client: MLGWHTTPClient,
  fileStore: BillFileStore,
  pdfExtractor: PdfTextExtractor,
  knownDocumentIds: Set<string>,
  backgroundSyncWorkerCount: number,
  skipDebugMessage: string,
  cancellation: MLGWScriptCancellation | undefined,
  progress: ((message: string) => void) | undefined,
  capture?: BillCaptureOptions,
): Promise<MLGWBillDownloadBatch> {
  const filter = filterKnownBillTargets(targets, knownDocumentIds);
  if (filter.skipped > 0) {
    progress?.(
      `${collection.displayName}: skipping ${fmt(filter.skipped)} previously synced bill${filter.skipped === 1 ? "" : "s"}`,
    );
    debugLog(`${collection.displayName}: skipping ${filter.skipped} bill target(s) ${skipDebugMessage}`);
  }

  if (filter.pending.length === 0) {
    const skipped = filter.skipped;
    progress?.(
      skipped > 0
        ? `${collection.displayName}: all ${fmt(skipped)} bill row${skipped === 1 ? "" : "s"} already synced`
        : `${collection.displayName}: no bill rows found`,
    );
    return { downloaded: [], skippedKnownDocuments: filter.skipped };
  }

  cancellation?.check();
  const downloadStartedAt = Date.now();
  debugStage(
    `${collection.displayName}: downloading bill documents`,
    `pending=${filter.pending.length} skipped=${filter.skipped} workers=${backgroundSyncWorkerCount}`,
  );
  const downloaded = await downloadBillTargets(
    filter.pending,
    collection,
    client,
    fileStore,
    pdfExtractor,
    backgroundSyncWorkerCount,
    cancellation,
    progress,
    capture,
  );
  logStageDuration(`${collection.displayName} download`, downloadStartedAt);
  return { downloaded, skippedKnownDocuments: filter.skipped };
}

/**
 * Build the collection's list artifacts and, when a handler is provided, hand the
 * metadata rows off (checking cancellation around the call). Port of
 * `buildAndSaveBillListArtifacts`.
 */
async function buildAndSaveBillListArtifacts(
  targets: BillTarget[],
  collection: MLGWBillCollection,
  cancellation: MLGWScriptCancellation | undefined,
  listMetadataHandler: ((rows: BillListDocumentMetadata[]) => Promise<void>) | undefined,
  progress: ((message: string) => void) | undefined,
): Promise<BillListArtifacts> {
  const metadataStartedAt = Date.now();
  debugStage(`${collection.displayName}: building list metadata`, `targets=${targets.length}`);
  const artifacts = billListArtifacts(targets);
  logProfileDuration(
    `${collection.displayName} list metadata build`,
    metadataStartedAt,
    `targets=${targets.length} statuses=${artifacts.statuses.length} metadataRows=${artifacts.metadata.length}`,
  );

  if (listMetadataHandler !== undefined) {
    progress?.(
      `${collection.displayName}: saving ${fmt(artifacts.metadata.length)} list row${artifacts.metadata.length === 1 ? "" : "s"}`,
    );
    const handlerStartedAt = Date.now();
    debugStage(`${collection.displayName}: saving list metadata`, `rows=${artifacts.metadata.length}`);
    cancellation?.check();
    await listMetadataHandler(artifacts.metadata);
    cancellation?.check();
    logProfileDuration(
      `${collection.displayName} list metadata handler`,
      handlerStartedAt,
      `metadataRows=${artifacts.metadata.length}`,
    );
    progress?.(
      `${collection.displayName}: saved ${fmt(artifacts.metadata.length)} list row${artifacts.metadata.length === 1 ? "" : "s"}`,
    );
  }

  return artifacts;
}

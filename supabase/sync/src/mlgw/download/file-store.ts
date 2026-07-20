/**
 * MLGW bill file store + PDF text-extraction seams, and worker-count helpers.
 *
 * Ports MLGWBillFileStore.swift's `BillFileStore` (disk writer) and the
 * concurrency helpers (`backgroundSyncConcurrency`, `backgroundParseConcurrency`,
 * `checkMLGWProcessingCancellation`).
 *
 * Adaptations (brief §2/§3):
 *   - No FileManager/disk. `BillFileStore.put(path, bytes, contentType)` keeps the
 *     bytes in memory and returns the (possibly de-duplicated) object path; the
 *     default `InMemoryBillFileStore` mirrors the Swift `uniqueDestination`
 *     collision handling. Real deployments swap in a Supabase Storage `mlgw-bills`
 *     implementation.
 *   - PDF text is behind `PdfTextExtractor.extractText(bytes)`. The default
 *     `UnimplementedPdfTextExtractor` throws `ScriptError.pdfKitUnavailable()`.
 */

import { BackgroundSyncWorkerConfiguration, MLGWScriptCancellation, ScriptError } from "../types";
import { env } from "../env";

// MARK: - File store (brief §2)

/**
 * Sink for a downloaded bill's bytes. `put` returns the final object path (which
 * may differ from `path` if the store de-duplicates), used as `DownloadedBill.filePath`.
 */
export interface BillFileStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<string>;
}

/**
 * The default in-memory `BillFileStore`. Holds every put in `files` keyed by the
 * resolved (unique) path, replicating the Swift `uniqueDestination` behavior:
 * on a name clash it appends `-2`…`-200`, then falls back to a UUID suffix.
 */
export class InMemoryBillFileStore implements BillFileStore {
  readonly files = new Map<string, { bytes: Uint8Array; contentType: string }>();

  put(path: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const unique = this.uniquePath(path);
    this.files.set(unique, { bytes, contentType });
    return Promise.resolve(unique);
  }

  private uniquePath(path: string): string {
    if (!this.files.has(path)) return path;
    const dot = path.lastIndexOf(".");
    const hasExt = dot > 0;
    const base = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot + 1) : "";
    for (let suffix = 2; suffix <= 200; suffix += 1) {
      const candidate = ext.length === 0 ? `${base}-${suffix}` : `${base}-${suffix}.${ext}`;
      if (!this.files.has(candidate)) return candidate;
    }
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const uuid = webCrypto?.randomUUID?.() ?? String(Date.now());
    return `${base}-${uuid}.${ext}`;
  }
}

// MARK: - PDF text extraction (brief §3)

/** Extracts plain text from PDF bytes. The HTML path never touches this seam. */
export interface PdfTextExtractor {
  extractText(bytes: Uint8Array): Promise<string>;
}

/**
 * The default, deliberately non-functional extractor: it throws
 * `ScriptError.pdfKitUnavailable()`, mirroring the Swift build without PDFKit.
 * Downloading falls back to HTML text when a PDF cannot be read.
 */
export class UnimplementedPdfTextExtractor implements PdfTextExtractor {
  extractText(_bytes: Uint8Array): Promise<string> {
    // TODO(mlgw): wire a PDF text lib (e.g. pdfjs-dist) and return its text.
    return Promise.reject(ScriptError.pdfKitUnavailable());
  }
}

// MARK: - Worker-count helpers (MLGWBillFileStore.swift)

/**
 * Resolve the download worker count: an explicit request is clamped; otherwise
 * `BACKGROUND_SYNC_WORKERS` / `MLGW_BILL_DOWNLOAD_CONCURRENCY` (falling back to the
 * default) is parsed and clamped. Port of `backgroundSyncConcurrency`.
 */
export function backgroundSyncConcurrency(requestedWorkerCount?: number | null): number {
  if (requestedWorkerCount !== undefined && requestedWorkerCount !== null) {
    return BackgroundSyncWorkerConfiguration.clampedWorkerCount(requestedWorkerCount);
  }
  const defaultCount = String(BackgroundSyncWorkerConfiguration.defaultWorkerCount);
  const rawValue =
    env("BACKGROUND_SYNC_WORKERS") ?? env("MLGW_BILL_DOWNLOAD_CONCURRENCY") ?? defaultCount;
  const parsed = Number.parseInt(rawValue, 10);
  const value = Number.isFinite(parsed) ? parsed : BackgroundSyncWorkerConfiguration.defaultWorkerCount;
  return BackgroundSyncWorkerConfiguration.clampedWorkerCount(value);
}

/**
 * Like `backgroundSyncConcurrency`, but additionally capped at (CPU cores - 1) to
 * keep parsing responsive. Uses `navigator.hardwareConcurrency` (Bun/Web) in
 * place of `ProcessInfo.activeProcessorCount`. Port of `backgroundParseConcurrency`.
 */
export function backgroundParseConcurrency(requestedWorkerCount?: number | null): number {
  const requested = backgroundSyncConcurrency(requestedWorkerCount);
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  const cores = nav?.hardwareConcurrency ?? 1;
  const responsiveCPUCap = Math.max(1, cores - 1);
  return Math.min(requested, responsiveCPUCap);
}

/**
 * Cooperative cancellation checkpoint. Port of `checkMLGWProcessingCancellation`;
 * the Swift also called `Task.checkCancellation()`, which has no TS analog, so
 * only the token check remains (brief §7).
 */
export function checkMLGWProcessingCancellation(cancellation?: MLGWScriptCancellation): void {
  cancellation?.check();
}

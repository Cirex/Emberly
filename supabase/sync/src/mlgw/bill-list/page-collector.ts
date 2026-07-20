/**
 * Fetch and parse every deterministic bill-list page for a collection, merging
 * and de-duplicating the targets across pages with bounded concurrency.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillListPageCollector.swift):
 *   collectBillTargetsFromDeterministicPages.
 *
 * The Swift `withTaskGroup` bounded worker pool is replaced by
 * `mapWithConcurrency` (brief §6): each work item is fetched/validated/parsed in
 * its own worker on a `copyForConcurrentRequests()` client; per-page errors are
 * collected (not thrown) and the first one is raised after the pass, exactly as
 * the Swift did. `mapWithConcurrency` preserves input order, so
 * `collectedErrors[0]` is the lowest-index failure.
 */

import { type HTTPResponse, type MLGWScriptCancellation, ScriptError } from "../types";
import {
  debugLog,
  debugStage,
  formattedDuration,
  formattedProfileRate,
  profileLog,
  readableErrorDescription,
} from "../env";
import { type MLGWHTTPClient, isCancellationError, mapWithConcurrency } from "../http";
import { logProfileDuration, formattedCount } from "./support";
import {
  billListPageSize,
  billListPageWorkItems,
  deterministicBillListStartPositions,
  totalItemCount,
} from "./counts";
import { validateBillListPage } from "./validation";
import { debugBillTargets, parsedBillTargets } from "./parser";
import { targetDocumentId } from "./row-metadata";
// Assumed to live in the download sibling barrel.
import type { BillListPageResult, BillTarget, MLGWBillCollection } from "../types";
import { backgroundSyncConcurrency, billTargetKey, fetchBillListPage } from "../download";

type ProgressCallback = (message: string) => void;

interface PageOutcome {
  result: BillListPageResult | null;
  error: unknown;
}

/** Faithful port of `collectBillTargetsFromDeterministicPages`. Returns `null` when no rows are found. */
export async function collectBillTargetsFromDeterministicPages(
  firstPage: HTTPResponse,
  client: MLGWHTTPClient,
  collection: MLGWBillCollection,
  cancellation?: MLGWScriptCancellation,
  requestedWorkerCount?: number,
  progress?: ProgressCallback,
): Promise<BillTarget[] | null> {
  cancellation?.check();
  const collectionProfileStartedAt = Date.now();
  debugStage(
    `${collection.displayName}: list row collection started`,
    `firstURL=${firstPage.url} firstBytes=${firstPage.bytes.length}`,
  );
  const planStartedAt = Date.now();
  const totalItems = totalItemCount(firstPage.text);
  const pageSize = billListPageSize(firstPage);
  const startPositions = deterministicBillListStartPositions(totalItems, pageSize);
  const workItems = billListPageWorkItems(firstPage, collection, startPositions, pageSize);
  const totalPages = Math.max(1, startPositions.length);
  const totalRowsText = totalItems === null ? "unknown" : String(totalItems);
  logProfileDuration(
    `${collection.displayName} list page plan`,
    planStartedAt,
    `totalRows=${totalRowsText} pageSize=${pageSize} pages=${totalPages} remainingFetches=${workItems.length}`,
  );
  debugStage(
    `${collection.displayName}: list page plan ready`,
    `totalRows=${totalRowsText} pageSize=${pageSize} pages=${totalPages} startPositions=${startPositions.join(",")}`,
  );

  const firstValidationStartedAt = Date.now();
  debugStage(`${collection.displayName}: validating list page 1`, `bytes=${firstPage.bytes.length}`);
  validateBillListPage(firstPage, collection, 1, totalPages);
  logProfileDuration(
    `${collection.displayName} list page 1 validation`,
    firstValidationStartedAt,
    `bytes=${firstPage.bytes.length}`,
  );

  if (totalItems !== null) {
    debugLog(
      `${collection.displayName}: detected ${totalItems} total bill row(s), configured list page size ${pageSize}, start positions ${startPositions.join(", ")}.`,
    );
  } else {
    debugLog(
      `${collection.displayName}: total bill row count was not visible; configured list page size ${pageSize}.`,
    );
  }
  profileLog(
    `${collection.displayName} list setup | totalRows=${totalRowsText} pageSize=${pageSize} pages=${totalPages} startPositions=${startPositions.join(",")}`,
  );
  if (totalItems !== null) {
    progress?.(
      `${collection.displayName}: reading ${formattedCount(totalItems)} bill rows from ${formattedCount(totalPages)} list page${totalPages === 1 ? "" : "s"}`,
    );
  } else {
    progress?.(`${collection.displayName}: reading bill rows from list`);
  }

  const targets: BillTarget[] = [];
  const seenTargets = new Set<string>();

  const mergeTargets = (pageTargets: BillTarget[], pageIndex: number): void => {
    const mergeStartedAt = Date.now();
    let pageTargetCount = 0;
    for (const target of pageTargets) {
      const documentId = targetDocumentId(target);
      const key = documentId !== null ? `document|${documentId}` : billTargetKey(target);
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      targets.push(target);
      pageTargetCount += 1;
    }
    debugLog(
      `${collection.displayName}: merged ${pageTargetCount} new bill row target(s) from list page ${pageIndex}.`,
    );
    logProfileDuration(
      `${collection.displayName} list page ${pageIndex} merge/dedupe`,
      mergeStartedAt,
      `newRows=${pageTargetCount} totalRows=${targets.length}`,
    );
  };

  const firstParseStartedAt = Date.now();
  progress?.(`${collection.displayName}: parsing list page 1 of ${formattedCount(totalPages)}`);
  debugStage(`${collection.displayName}: parsing list page 1`, `bytes=${firstPage.bytes.length}`);
  const firstPageTargets = parsedBillTargets(firstPage, collection, 1, cancellation);
  const firstParseElapsed = logProfileDuration(
    `${collection.displayName} list page 1 HTML parse`,
    firstParseStartedAt,
    `rows=${firstPageTargets.length} bytes=${firstPage.bytes.length}`,
  );
  debugLog(
    `${collection.displayName}: parsed ${firstPageTargets.length} bill row target(s) from list page 1 of ${totalPages} in ${formattedDuration(firstParseElapsed)}.`,
  );
  mergeTargets(firstPageTargets, 1);
  progress?.(
    `${collection.displayName}: read ${formattedCount(targets.length)} of ${formattedCount(totalItems ?? targets.length)} bill row${targets.length === 1 ? "" : "s"}`,
  );

  if (workItems.length > 0) {
    const remainingPageStartedAt = Date.now();
    const workerCount = Math.min(backgroundSyncConcurrency(requestedWorkerCount), workItems.length);
    progress?.(`${collection.displayName}: loading remaining list pages`);
    debugLog(
      `${collection.displayName}: loading ${workItems.length} remaining list page(s) with ${workerCount} worker(s).`,
    );
    profileLog(
      `${collection.displayName} list page worker setup | remainingPages=${workItems.length} workers=${workerCount}`,
    );

    let completed = 0;
    const outcomes = await mapWithConcurrency<(typeof workItems)[number], PageOutcome>(
      workItems,
      workerCount,
      async (work): Promise<PageOutcome> => {
        const startedAt = Date.now();
        try {
          cancellation?.check();
          const workerClient = client.copyForConcurrentRequests();
          const response = await fetchBillListPage(work.target, workerClient, cancellation);
          logProfileDuration(
            `${collection.displayName} list page ${work.pageIndex} network`,
            startedAt,
            `startPos=${work.startPos} http=${response.status} bytes=${response.bytes.length}`,
          );
          validateBillListPage(response, collection, work.pageIndex, totalPages);
          const parseStartedAt = Date.now();
          const pageTargets = parsedBillTargets(response, collection, work.pageIndex, cancellation);
          logProfileDuration(
            `${collection.displayName} list page ${work.pageIndex} HTML parse`,
            parseStartedAt,
            `startPos=${work.startPos} rows=${pageTargets.length} bytes=${response.bytes.length}`,
          );
          completed += 1;
          progress?.(
            `${collection.displayName}: fetched ${formattedCount(completed)} of ${formattedCount(workItems.length)} remaining list page${workItems.length === 1 ? "" : "s"}`,
          );
          return {
            result: { pageIndex: work.pageIndex, startPos: work.startPos, targets: pageTargets },
            error: null,
          };
        } catch (error) {
          if (isCancellationError(error)) {
            return { result: null, error: null };
          }
          debugLog(
            `${collection.displayName}: failed list page ${work.pageIndex} startPos ${work.startPos}: ${readableErrorDescription(error)}`,
          );
          completed += 1;
          progress?.(
            `${collection.displayName}: fetched ${formattedCount(completed)} of ${formattedCount(workItems.length)} remaining list page${workItems.length === 1 ? "" : "s"}`,
          );
          return { result: null, error };
        }
      },
    );

    cancellation?.check();
    const firstErrorIndex = outcomes.findIndex((outcome) => outcome.error !== null);
    if (firstErrorIndex >= 0) {
      const failedWork = workItems[firstErrorIndex];
      throw ScriptError.badResponse(
        `Could not load ${collection.rawValue} bill list page ${failedWork.pageIndex} of ${totalPages}: ${readableErrorDescription(outcomes[firstErrorIndex].error)}`,
      );
    }

    const collectedResults = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is BillListPageResult => result !== null);
    for (const result of [...collectedResults].sort((a, b) => a.pageIndex - b.pageIndex)) {
      mergeTargets(result.targets, result.pageIndex);
      progress?.(
        `${collection.displayName}: read ${formattedCount(targets.length)} of ${formattedCount(totalItems ?? targets.length)} bill row${targets.length === 1 ? "" : "s"}`,
      );
    }

    const wallElapsed = logProfileDuration(
      `${collection.displayName} remaining list pages wall time`,
      remainingPageStartedAt,
      `pages=${collectedResults.length} workers=${workerCount}`,
    );
    profileLog(
      `${collection.displayName} list page rate | ${formattedProfileRate(collectedResults.length, wallElapsed)}`,
    );
  }

  if (targets.length === 0) {
    debugStage(`${collection.displayName}: list row collection finished empty`, `pages=${totalPages}`);
    return null;
  }
  debugBillTargets(targets, collection);
  if (totalItems !== null) {
    progress?.(
      `${collection.displayName}: collected ${formattedCount(targets.length)} of ${formattedCount(totalItems)} bill row${totalItems === 1 ? "" : "s"}`,
    );
  } else {
    progress?.(
      `${collection.displayName}: collected ${formattedCount(targets.length)} bill row${targets.length === 1 ? "" : "s"}`,
    );
  }
  const collectionElapsed = logProfileDuration(
    `${collection.displayName} list row collection total`,
    collectionProfileStartedAt,
    `pages=${totalPages} rows=${targets.length}`,
  );
  profileLog(
    `${collection.displayName} list row rate | ${formattedProfileRate(targets.length, collectionElapsed)}`,
  );
  debugStage(
    `${collection.displayName}: list row collection finished`,
    `rows=${targets.length} pages=${totalPages} duration=${formattedDuration(collectionElapsed)}`,
  );
  return targets;
}

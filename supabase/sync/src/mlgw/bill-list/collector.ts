/**
 * Top-level bill-list collection entry points: open the first list page for a
 * collection, and collect every bill target across all list pages.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillListCollector.swift):
 *   loadBillTypePage, collectBillTargets.
 */

import { type HTTPResponse, type MLGWScriptCancellation, ScriptError } from "../types";
import { debugLog } from "../env";
import type { MLGWHTTPClient } from "../http";
import { queryFields } from "../text";
import { logProfileDuration } from "./support";
import { configuredBillingPageSize } from "./counts";
import { collectBillTargetsFromDeterministicPages } from "./page-collector";
import type { BillTarget, MLGWBillCollection } from "../types";
import { billingWorkspaceTarget, fetchBillListPage } from "../download";

type ProgressCallback = (message: string) => void;

/** Build + fetch the first Bills-Workspace list page for `scope`. Port of `loadBillTypePage`. */
export async function loadBillTypePage(
  scope: MLGWBillCollection,
  page: HTTPResponse,
  client: MLGWHTTPClient,
  cancellation?: MLGWScriptCancellation,
  progress?: ProgressCallback,
): Promise<HTTPResponse> {
  cancellation?.check();
  const buildStartedAt = Date.now();
  const target = billingWorkspaceTarget(page, scope);

  if (target === null) {
    throw ScriptError.badResponse(
      "Could not build the MLGW Bills-Workspace URL because the billing session did not include a sessionHandle and client.",
    );
  }
  logProfileDuration(`${scope.displayName} list target build`, buildStartedAt, `sourceBytes=${page.bytes.length}`);

  const query = queryFields(target.url);
  debugLog(
    `${scope.displayName}: loading documentSetId ${query["documentSetId"] ?? scope.documentSetId}, pageSize ${query["pageSize"] ?? String(configuredBillingPageSize())}, startPos ${query["startPos"] ?? "0"}.`,
  );
  debugLog(`${scope.displayName}: direct list URL ${target.url.toString()}`);
  progress?.(`${scope.displayName}: opening list`);
  const startedAt = Date.now();
  const response = await fetchBillListPage(target, client, cancellation);
  logProfileDuration(
    `${scope.displayName} first list page network`,
    startedAt,
    `http=${response.status} bytes=${response.bytes.length} url=${response.url}`,
  );
  debugLog(
    `${scope.displayName}: direct list response HTTP ${response.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
  );
  return response;
}

/** Collect all bill targets for `collection`, throwing when the list is missing. Port of `collectBillTargets`. */
export async function collectBillTargets(
  firstPage: HTTPResponse,
  client: MLGWHTTPClient,
  collection: MLGWBillCollection,
  cancellation?: MLGWScriptCancellation,
  requestedWorkerCount?: number,
  progress?: ProgressCallback,
): Promise<BillTarget[]> {
  const targets = await collectBillTargetsFromDeterministicPages(
    firstPage,
    client,
    collection,
    cancellation,
    requestedWorkerCount,
    progress,
  );
  if (targets === null) {
    throw ScriptError.badResponse(
      `MLGW did not return the expected ${collection.rawValue} bill list.`,
    );
  }
  return targets;
}

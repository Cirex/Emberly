/**
 * The bill-list HTML target parser: turn a list page's HTML into the deduped
 * `BillTarget[]`, enforcing the page's expected row count and raising a
 * diagnostic error when extraction comes up short.
 *
 * Ports:
 *   - MLGWBillListParser.swift        -> billTargets, uniqueBillTargets
 *   - MLGWBillListTargetParsing.swift -> parsedBillTargets, debugBillTargets
 *     (these two Swift helpers are thin wrappers over `billTargets`/`targetDocumentId`,
 *     which this group owns, so they are ported here to avoid a cyclic dependency
 *     with the download group.)
 *
 * Case-insensitive `String.range(of:)` marker checks become `includes` on a
 * lowercased copy of the HTML.
 */

import { type HTTPResponse, type MLGWScriptCancellation, ScriptError } from "../types";
import { debugLog, debugStage } from "../env";
import { queryFields } from "../text";
import { logProfileDuration, utf8ByteLength } from "./support";
import { expectedBillListItemCount, totalItemCount, visibleItemCount } from "./counts";
import {
  billListExtractionDiagnostics,
  billListExtractionFailureMessage,
} from "./diagnostics";
import { targetDocumentId } from "./row-metadata";
// Assumed to live in the download sibling barrel (target-extraction group).
import type { BillTarget, MLGWBillCollection } from "../types";
import {
  billListCardTargets,
  billListRowTargets,
  billTargetKey,
  checkMLGWProcessingCancellation,
} from "../download";

/** `String(n)` for an Int, or `"unknown"` for a nil count — matches `optional.map(String.init) ?? "unknown"`. */
function countText(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

/** Parse `html` into the collection's deduped bill targets, validating the row count. Port of `billTargets`. */
export function billTargets(
  html: string,
  baseURL: URL,
  profileLabel: string | null = null,
  cancellation?: MLGWScriptCancellation,
): BillTarget[] {
  const totalStartedAt = profileLabel === null ? null : Date.now();
  checkMLGWProcessingCancellation(cancellation);
  if (profileLabel !== null) {
    debugStage(`${profileLabel}: target parser entered`, `bytes=${utf8ByteLength(html)}`);
  }

  const lowerHTML = html.toLowerCase();
  const hasBillCards = lowerHTML.includes("pay_bill_header");
  const rowTargets = hasBillCards ? [] : billListRowTargets(html, baseURL, profileLabel ?? undefined, cancellation);
  const cardTargets = hasBillCards
    ? billListCardTargets(html, baseURL, profileLabel ?? undefined, cancellation)
    : [];
  const targets = [...rowTargets, ...cardTargets];
  const extractionPath = hasBillCards ? "billCards" : "tableRows";

  const visibleCount = visibleItemCount(html);
  const listTotalCount = totalItemCount(html);
  const expectedCount = expectedBillListItemCount(html, baseURL);
  const action = (queryFields(baseURL)["action"] ?? "").toLowerCase();
  const isWorkspaceListPage =
    action === "bills-workspace" ||
    listTotalCount !== null ||
    visibleCount !== null ||
    lowerHTML.includes("archivedocumentlist") ||
    lowerHTML.includes("multipaydocumentlist") ||
    lowerHTML.includes("pay_bill_header");

  if (isWorkspaceListPage) {
    const uniqueTargets = uniqueBillTargets(targets);
    if (uniqueTargets.length === 0) {
      const expectedRows = expectedCount ?? visibleCount ?? listTotalCount;
      if (profileLabel !== null && totalStartedAt !== null) {
        logProfileDuration(
          `${profileLabel} target extraction total`,
          totalStartedAt,
          `targets=0 expectedRows=${countText(expectedRows)} visibleRows=${countText(visibleCount)} totalRows=${countText(listTotalCount)} fastPath=${extractionPath}`,
        );
      }
      if (expectedRows !== null && expectedRows > 0) {
        const diagnostics = billListExtractionDiagnostics(html);
        debugLog(`MLGW bill list target extraction failed. ${diagnostics.summary}`);
        throw ScriptError.badResponse(billListExtractionFailureMessage(expectedRows, 0, diagnostics));
      }
      return [];
    }
    if (expectedCount !== null && uniqueTargets.length < expectedCount) {
      const diagnostics = billListExtractionDiagnostics(html);
      if (profileLabel !== null) {
        debugLog(
          `${profileLabel}: parsed ${uniqueTargets.length} bill row target(s) while page displayed ${expectedCount}. ${diagnostics.summary}`,
        );
      } else {
        debugLog(
          `MLGW bill list target extraction was short. parsed ${uniqueTargets.length} bill row target(s) while page displayed ${expectedCount}. ${diagnostics.summary}`,
        );
      }
      throw ScriptError.badResponse(
        billListExtractionFailureMessage(expectedCount, uniqueTargets.length, diagnostics),
      );
    }
    if (profileLabel !== null && totalStartedAt !== null) {
      logProfileDuration(
        `${profileLabel} target extraction total`,
        totalStartedAt,
        `targets=${uniqueTargets.length} expectedRows=${countText(expectedCount)} visibleRows=${countText(visibleCount)} totalRows=${countText(listTotalCount)} fastPath=${extractionPath}`,
      );
    }
    return uniqueTargets;
  }

  const uniqueTargets = uniqueBillTargets(targets);
  if (profileLabel !== null && totalStartedAt !== null) {
    logProfileDuration(
      `${profileLabel} target extraction total`,
      totalStartedAt,
      `targets=${uniqueTargets.length} visibleRows=${countText(visibleCount)} totalRows=${countText(listTotalCount)} fastPath=${extractionPath}`,
    );
  }
  return uniqueTargets;
}

/** Dedupe targets by document id (`document|<id>`), falling back to `billTargetKey`. Port of `uniqueBillTargets`. */
export function uniqueBillTargets(targets: BillTarget[]): BillTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const documentId = targetDocumentId(target);
    const key = documentId !== null ? `document|${documentId}` : billTargetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse a fetched list page into targets, stamping each with the collection's
 * `isCurrent`. Port of `parsedBillTargets(from:collection:pageIndex:cancellation:)`.
 */
export function parsedBillTargets(
  page: HTTPResponse,
  collection: MLGWBillCollection,
  pageIndex: number | null = null,
  cancellation?: MLGWScriptCancellation,
): BillTarget[] {
  const profileLabel = pageIndex === null ? null : `${collection.displayName} list page ${pageIndex}`;
  return billTargets(page.text, new URL(page.url), profileLabel, cancellation).map((target) => ({
    ...target,
    isCurrent: collection.isCurrent,
  }));
}

/** Emit a debug line summarizing the collected targets. Port of `debugBillTargets`. */
export function debugBillTargets(targets: BillTarget[], collection: MLGWBillCollection): void {
  const documentIds = new Set<string>();
  for (const target of targets) {
    const documentId = targetDocumentId(target);
    if (documentId !== null) documentIds.add(documentId);
  }
  debugLog(
    `${collection.displayName}: collected ${targets.length} bill link(s), ${documentIds.size} unique document id(s).`,
  );
}

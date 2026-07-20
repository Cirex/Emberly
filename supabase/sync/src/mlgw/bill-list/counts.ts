/**
 * MLGW bill-list pagination math: total/visible/expected item counts, the
 * configured page size, and the deterministic start-position / work-item plan.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillListCounts.swift):
 *   totalItemCount, itemRangeCount, visibleItemCount, expectedBillListItemCount,
 *   renderedBillListItemCount, configuredBillingPageSize, billingWorkspaceCacheBuster,
 *   billListPageSize, deterministicBillListStartPositions (both overloads),
 *   billListPageWorkItems (both overloads).
 *
 * The two Swift overloads that take a `HTTPResponse` are renamed with a
 * `…FromPage` suffix (TS has no overloading on argument shape); the core numeric
 * overloads keep the Swift name. `HTTPResponse.url` is a string here, so it is
 * wrapped in `new URL(...)` before `queryFields`.
 */

import { env } from "../env";
import type { HTTPResponse } from "../types";
import { firstMatch, queryFields } from "../text";
// Assumed to live in the download sibling barrel (target/workspace group).
import type { BillListPageWork, MLGWBillCollection } from "../types";
import {
  billingWorkspaceSession,
  billingWorkspaceTargetFromSession,
  billListCardSections,
} from "../download";

/** Parse a match to a non-negative int, or `null` when absent/non-numeric. */
function intOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Total bill rows the list page advertises ("… of N"). Port of `totalItemCount`. */
export function totalItemCount(html: string): number | null {
  const raw =
    firstMatch(html, String.raw`Items:\s*[0-9]+\s*-\s*[0-9]+\s+of\s+([0-9]+)`) ??
    firstMatch(html, String.raw`\b[0-9]+\s*-\s*[0-9]+\s+of\s+([0-9]+)\b`);
  return intOrNull(raw);
}

/**
 * Count implied by a `start-end` range pattern (two capture groups), or `null`.
 * Port of `itemRangeCount(in:pattern:)`.
 */
export function itemRangeCount(html: string, pattern: string): number | null {
  const regex = new RegExp(pattern, "is");
  const match = regex.exec(html);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start + 1;
}

/** Rows visible on the current page (selected option / range). Port of `visibleItemCount`. */
export function visibleItemCount(html: string): number | null {
  const selectedOptionPattern = String.raw`<option\b(?=[^>]*\bselected(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^>\s]+))?)[^>]*>\s*([0-9]+)\s*-\s*([0-9]+)\s+of\s+[0-9]+`;
  const itemRangePattern = String.raw`Items:\s*([0-9]+)\s*-\s*([0-9]+)\s+of\s+[0-9]+`;
  const genericRangePattern = String.raw`\b([0-9]+)\s*-\s*([0-9]+)\s+of\s+[0-9]+\b`;
  for (const pattern of [selectedOptionPattern, itemRangePattern, genericRangePattern]) {
    const count = itemRangeCount(html, pattern);
    if (count !== null) return count;
  }
  return null;
}

/**
 * Best estimate of how many bill rows this specific page should yield, combining
 * the rendered card count with the visible/total range. Port of
 * `expectedBillListItemCount(in:url:)`.
 */
export function expectedBillListItemCount(html: string, url: URL): number | null {
  const renderedCount = renderedBillListItemCount(html);
  const visibleCount = visibleItemCount(html);
  const fields = queryFields(url);

  let rangeCount: number | null;
  const total = totalItemCount(html);
  const startPos = intOrNull(fields["startPos"] ?? null);
  if (total !== null && startPos !== null && startPos >= 0) {
    const remaining = Math.max(0, total - startPos);
    if (visibleCount !== null) {
      rangeCount = Math.min(visibleCount, remaining);
    } else {
      const pageSize = intOrNull(fields["pageSize"] ?? null);
      if (pageSize !== null && pageSize > 0) {
        rangeCount = Math.min(pageSize, remaining);
      } else {
        rangeCount = remaining;
      }
    }
  } else {
    rangeCount = visibleCount ?? totalItemCount(html);
  }

  if (renderedCount !== null && rangeCount !== null) return Math.max(renderedCount, rangeCount);
  if (renderedCount !== null) return renderedCount;
  if (rangeCount !== null) return rangeCount;
  return null;
}

/** Card-based rendered row count, or `null` when there are no card sections. */
export function renderedBillListItemCount(html: string): number | null {
  const cardCount = billListCardSections(html).length;
  return cardCount > 0 ? cardCount : null;
}

/** `MLGW_BILL_PAGE_SIZE` (default 1000). Port of `configuredBillingPageSize`. */
export function configuredBillingPageSize(): number {
  const raw = env("MLGW_BILL_PAGE_SIZE", "1000") ?? "1000";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 1000;
}

/** Millisecond epoch cache-buster string. Port of `billingWorkspaceCacheBuster`. */
export function billingWorkspaceCacheBuster(): string {
  return String(Math.floor(Date.now()));
}

/** Effective page size for a fetched list page. Port of `billListPageSize(from:)`. */
export function billListPageSize(page: HTTPResponse): number {
  const rendered = renderedBillListItemCount(page.text);
  if (rendered !== null && rendered > 0) return rendered;
  const visible = visibleItemCount(page.text);
  if (visible !== null && visible > 0) return visible;
  const urlPageSize = intOrNull(queryFields(new URL(page.url))["pageSize"] ?? null);
  if (urlPageSize !== null && urlPageSize > 0) return urlPageSize;
  return configuredBillingPageSize();
}

/** `deterministicBillListStartPositions(from: page)` overload. */
export function deterministicBillListStartPositionsFromPage(page: HTTPResponse): number[] {
  return deterministicBillListStartPositions(totalItemCount(page.text), billListPageSize(page));
}

/**
 * The `startPos` values to request, striding by `pageSize`. Falls back to `[0]`
 * when the total is unknown. Port of the numeric
 * `deterministicBillListStartPositions(totalItems:pageSize:)` overload.
 */
export function deterministicBillListStartPositions(
  totalItems: number | null,
  pageSize: number,
): number[] {
  if (totalItems === null || totalItems <= 0 || pageSize <= 0) return [0];
  const positions: number[] = [];
  for (let start = 0; start < totalItems; start += pageSize) positions.push(start);
  return positions;
}

/** `billListPageWorkItems(from: page, collection:)` overload. */
export function billListPageWorkItemsFromPage(
  page: HTTPResponse,
  collection: MLGWBillCollection,
): BillListPageWork[] {
  const starts = deterministicBillListStartPositionsFromPage(page);
  const pageSize = billListPageSize(page);
  return billListPageWorkItems(page, collection, starts, pageSize);
}

/**
 * The remaining (non-first) list-page fetches to perform, one per `startPos > 0`.
 * Returns `[]` when there is only one page or the workspace session is missing.
 * Port of the full `billListPageWorkItems(from:collection:startPositions:pageSize:)`.
 */
export function billListPageWorkItems(
  page: HTTPResponse,
  collection: MLGWBillCollection,
  startPositions: number[],
  pageSize: number,
): BillListPageWork[] {
  if (startPositions.length <= 1) return [];

  const session = billingWorkspaceSession(page);
  if (session === null) return [];

  const work: BillListPageWork[] = [];
  startPositions.forEach((startPosition, offset) => {
    if (startPosition <= 0) return;
    const target = billingWorkspaceTargetFromSession(session, collection, startPosition, pageSize);
    if (target === null) return;
    work.push({ pageIndex: offset + 1, startPos: startPosition, target });
  });
  return work;
}

/**
 * Port of KrakenCore/Services/MLGW/MLGWParser+DocumentStatuses.swift (pure
 * subset).
 *
 * Swift `updateBillStatusesCooperatively` folded the scraped statuses into a
 * `documentId -> isCurrent` map (OR-ing `isCurrent` across duplicates, dropping
 * blank ids) and then wrote them onto the SwiftData bills. The pure port returns
 * that deduped `BillDocumentStatus[]`; the job layer applies it to `mlgw_bills`.
 */

import type { BillDocumentStatus } from "../types";

/** Faithful port of the status-dedupe half of `updateBillStatusesCooperatively`. */
export function mergeBillDocumentStatuses(statuses: BillDocumentStatus[]): BillDocumentStatus[] {
  const order: string[] = [];
  const byId = new Map<string, boolean>();
  for (const status of statuses) {
    const documentId = status.documentId.trim();
    if (documentId.length === 0) continue;
    if (!byId.has(documentId)) order.push(documentId);
    byId.set(documentId, (byId.get(documentId) ?? false) || status.isCurrent);
  }
  return order.map((documentId) => ({ documentId, isCurrent: byId.get(documentId) ?? false }));
}

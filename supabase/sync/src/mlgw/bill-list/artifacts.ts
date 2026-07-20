/**
 * Fold the parsed `BillTarget[]` into the two bill-list artifacts the job layer
 * consumes: per-document status flags and per-document list metadata; plus the
 * merge/known-filter helpers.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillListArtifacts.swift):
 *   BillListArtifacts, billListArtifacts, mergedBillListMetadata,
 *   mergedBillDocumentStatuses, filterKnownBillTargets, and the `BillTarget.rowMetadata`
 *   extension (ported as the free function `billTargetRowMetadata`).
 */

import type { BillDocumentStatus, BillListDocumentMetadata } from "../types";
import type { BillRowMetadata, BillTarget } from "../types";
import { compareStrings } from "./support";
import { metadata, targetDocumentId } from "./row-metadata";

/** Status flags + list metadata derived from a page's targets. Port of the Swift struct. */
export interface BillListArtifacts {
  statuses: BillDocumentStatus[];
  metadata: BillListDocumentMetadata[];
}

/**
 * The row-level metadata for a target: prefer the fields the target already
 * carries, else scrape its `rowText`. Port of the `BillTarget.rowMetadata`
 * extension property.
 */
export function billTargetRowMetadata(target: BillTarget): BillRowMetadata {
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

/** Build deduped, sorted statuses + metadata from targets. Port of `billListArtifacts(from:)`. */
export function billListArtifacts(targets: BillTarget[]): BillListArtifacts {
  const statusesByDocumentId = new Map<string, boolean>();
  const metadataByDocumentId = new Map<string, BillListDocumentMetadata>();

  for (const target of targets) {
    const documentId = targetDocumentId(target);
    if (documentId === null) continue;
    statusesByDocumentId.set(
      documentId,
      (statusesByDocumentId.get(documentId) ?? false) || target.isCurrent,
    );

    const row = billTargetRowMetadata(target);
    const candidate: BillListDocumentMetadata = {
      documentId,
      isCurrent: target.isCurrent,
      accountNumber: row.accountNumber ?? "",
      serviceAddress: row.address ?? "",
      amountDue: row.amountDue ?? "",
      dueDate: row.dueDate ?? "",
    };
    const existing = metadataByDocumentId.get(documentId);
    metadataByDocumentId.set(
      documentId,
      existing === undefined ? candidate : mergedBillListMetadata(existing, candidate),
    );
  }

  const statuses = [...statusesByDocumentId.entries()]
    .map(([documentId, isCurrent]) => ({ documentId, isCurrent }))
    .sort((a, b) => compareStrings(a.documentId, b.documentId));
  const metadataRows = [...metadataByDocumentId.values()].sort((a, b) =>
    compareStrings(a.documentId, b.documentId),
  );

  return { statuses, metadata: metadataRows };
}

/** Combine two metadata records for the same document (first non-empty wins). Port of `mergedBillListMetadata`. */
export function mergedBillListMetadata(
  first: BillListDocumentMetadata,
  second: BillListDocumentMetadata,
): BillListDocumentMetadata {
  return {
    documentId: first.documentId,
    isCurrent: first.isCurrent || second.isCurrent,
    accountNumber: first.accountNumber.length === 0 ? second.accountNumber : first.accountNumber,
    serviceAddress: first.serviceAddress.length === 0 ? second.serviceAddress : first.serviceAddress,
    amountDue: first.amountDue.length === 0 ? second.amountDue : first.amountDue,
    dueDate: first.dueDate.length === 0 ? second.dueDate : first.dueDate,
  };
}

/** Dedupe + OR-merge a flat list of statuses by trimmed document id. Port of `mergedBillDocumentStatuses`. */
export function mergedBillDocumentStatuses(statuses: BillDocumentStatus[]): BillDocumentStatus[] {
  const statusesByDocumentId = new Map<string, boolean>();
  for (const status of statuses) {
    const documentId = status.documentId.trim();
    if (documentId.length === 0) continue;
    statusesByDocumentId.set(
      documentId,
      (statusesByDocumentId.get(documentId) ?? false) || status.isCurrent,
    );
  }
  return [...statusesByDocumentId.entries()]
    .map(([documentId, isCurrent]) => ({ documentId, isCurrent }))
    .sort((a, b) => compareStrings(a.documentId, b.documentId));
}

/** Split targets into the ones to fetch vs. the count skipped as already-known. Port of `filterKnownBillTargets`. */
export function filterKnownBillTargets(
  targets: BillTarget[],
  knownDocumentIds: Set<string>,
): { pending: BillTarget[]; skipped: number } {
  if (knownDocumentIds.size === 0) return { pending: targets, skipped: 0 };

  const pending: BillTarget[] = [];
  let skipped = 0;
  for (const target of targets) {
    const documentId = targetDocumentId(target);
    if (documentId !== null && knownDocumentIds.has(documentId)) {
      skipped += 1;
    } else {
      pending.push(target);
    }
  }
  return { pending, skipped };
}

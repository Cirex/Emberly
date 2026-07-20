/**
 * The pure replacement for the Swift SwiftData list-metadata upsert.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/):
 *   - MLGWParser+ListMetadata.swift     -> (see note) `MLGWParser.upsertListMetadata`
 *   - MLGWParser+ListMetadataRows.swift -> `validDocumentKey`
 *
 * Brief §1 / task note: the Swift `upsertListMetadata` mutated `@Model`
 * `MLGWAccount` / `MLGWBill` objects in a `ModelContext`. Instead of persisting,
 * this exposes a pure `listMetadataRows(...)` that returns the
 * `BillListDocumentMetadata[]` the **job layer** maps into `mlgw_accounts` /
 * `mlgw_bills` rows (via `upsertMirror`). The account/bill field derivation the
 * Swift `upsertListMetadataAccount` / `upsertListMetadataBill` performed
 * (sanitized service address, `makeAccountId`, house-account detection, unit
 * linking, amount/date coercion) is intentionally NOT ported here — those belong
 * to the job-layer row mapper (and its `../parse` model-key / unit-matching
 * helpers), keeping this module free of persistence and SwiftData concepts.
 *
 * The only rule preserved from the Swift loop's per-row guard is
 * `validDocumentKey`: a row is emitted only when it yields a non-empty document
 * key for the property.
 */

import type { BillListDocumentMetadata, MLGWSyncProperty } from "../types";
// Assumed to live in the parse sibling barrel (model-keys group).
import { documentKey } from "../parse";

/**
 * The composite document key for a metadata row, or `null` when the row has no
 * usable document id. Port of `MLGWParser.validDocumentKey(for:propertyId:)`.
 */
export function validDocumentKey(row: BillListDocumentMetadata, propertyId: string): string | null {
  const documentId = row.documentId.trim();
  if (documentId.length === 0) return null;
  return documentKey(propertyId, documentId);
}

/** Options mirroring the Swift `upsertListMetadata` knobs the job layer may honor. */
export interface ListMetadataRowsOptions {
  /** Swift `linkAccountsToUnits`; consumed by the job-layer mapper, not here. */
  linkAccountsToUnits?: boolean;
}

/**
 * The valid list-metadata rows for a property, in input order — the pure,
 * persistence-free stand-in for `MLGWParser.upsertListMetadata`. The job layer
 * upserts the result into `mlgw_accounts` / `mlgw_bills`.
 */
export function listMetadataRows(
  metadata: BillListDocumentMetadata[],
  property: MLGWSyncProperty,
  _options: ListMetadataRowsOptions = {},
): BillListDocumentMetadata[] {
  if (metadata.length === 0) return [];
  return metadata.filter((row) => validDocumentKey(row, property.id) !== null);
}

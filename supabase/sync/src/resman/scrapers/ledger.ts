/**
 * Ledger upsert mapper — pure port of `upsertLedger` in
 * KrakenCore/Services/ResMan/ResManUnitDetailSync.swift.
 *
 * The Swift `upsertLedger` mutated a SwiftData `Lease.transactions` relationship
 * (insert/update/delete against the live rows, with a drift check that only
 * rewrote changed entries). Here it becomes a pure function returning
 * `ResmanTransactionRow[]`; the JOB layer calls `upsertMirror` and performs the
 * scoped delete-missing per lease, so the drift optimization is unnecessary.
 *
 * Two Swift invariants are preserved:
 *   - never-delete-on-empty: `guard !rows.isEmpty else { return }` — an
 *     un-fetched ledger (empty input) must NOT wipe stored transactions. This
 *     mapper returns `[]` for empty input and the job leaves the lease's
 *     transactions untouched (it only delete-misses within a *fetched* set).
 *   - skip rows with an empty `transactionId` (`incomingRows` filter).
 *
 * `resman_ledger_entry_id == transaction_id == dict "transactionId"` (the Swift
 * `Transaction.ledgerEntryId`/`transactionId` are both the ResMan transaction
 * id). Duplicate `transactionId`s within one fetch collapse to the first
 * occurrence to satisfy the unique PK (SwiftData's `@Attribute(.unique)`).
 */

import { numOrNull, parseLedgerDate, str } from "./parse";
import type { ResmanTransactionRow } from "./types";

/**
 * Port of `upsertLedger`. Maps fetched ledger rows to transaction row DTOs for a
 * single lease. Rows with an empty `transactionId` are skipped; input order is
 * preserved. Returns `[]` for empty input (the job then leaves stored
 * transactions untouched — never-delete-on-empty).
 *
 * Dict keys consumed: transactionId, transactionType, date, reference, batch,
 * batchId, category, description, notes, charges, credits, balance.
 */
export function mapLedgerRows(
  rows: Record<string, unknown>[],
  ctx: { leaseId: string; unitId: string; propertyId: string },
): ResmanTransactionRow[] {
  if (rows.length === 0) return [];

  const out: ResmanTransactionRow[] = [];
  const seen = new Set<string>();

  // ResMan serves the table top-down: index 0 is the most current entry and
  // the last row is the ledger's first. The sequence flips that so 0 = oldest,
  // preserving the running-balance order however many rows share a date.
  let index = -1;
  for (const row of rows) {
    index += 1;
    const transactionId = str(row, "transactionId");
    if (transactionId.length === 0) continue;
    if (seen.has(transactionId)) continue;
    seen.add(transactionId);

    out.push({
      resman_ledger_entry_id: transactionId,
      resman_property_id: ctx.propertyId,
      resman_unit_id: ctx.unitId,
      resman_lease_id: ctx.leaseId,
      transaction_id: transactionId,
      transaction_type: str(row, "transactionType"),
      date: parseLedgerDate(str(row, "date")),
      reference: str(row, "reference"),
      batch: str(row, "batch"),
      batch_id: str(row, "batchId"),
      category: str(row, "category"),
      ledger_description: str(row, "description"),
      notes: str(row, "notes"),
      charges: numOrNull(row["charges"]),
      credits: numOrNull(row["credits"]),
      balance: numOrNull(row["balance"]),
      ledger_sequence: rows.length - 1 - index,
    });
  }

  return out;
}

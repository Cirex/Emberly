/**
 * Lease upsert mapper — pure port of `upsertLease` and `applyLeaseTabData`, plus
 * the lease-status predicates (`isActiveLease`/`isDeniedLease`/`isPendingLease`)
 * and the most-recent/current classification, from
 * KrakenCore/Services/ResMan/ResManUnitDetailSync.swift.
 *
 * The Swift `upsertLease` mutated a SwiftData `Lease` (its "keep stored value
 * when the source key is absent" `?? lease.x` idiom preserved un-fetched fields
 * against the live DB). Here it becomes a pure function returning a
 * `ResmanLeaseRow`: the mapper always receives a full lease scrape, so absent
 * keys coerce to "" / null and the JOB layer's `upsertMirror` overwrites. Date
 * columns use `parseLedgerDate` (a superset of the Swift ISO `parseISODate` that
 * also tolerates `M/d/yyyy`); the scrape dict already stores ISO values.
 *
 * Per-person tab data (vehicles/employment/insurance/addresses/alternate
 * contacts) does NOT hang off the lease in the Swift model — it is owned by each
 * `Resident` (see `mapResidents` in `./residents`). `mapLeaseTabs` is provided
 * for scrape paths that surface those tab arrays at the lease-dict top level
 * (e.g. current-lease-tabs), attributing them to a supplied primary
 * `personLeaseId`; the lease ledger itself is mapped by `./ledger`.
 *
 * The empty-`leaseId` guard in the Swift `upsertLease` (`guard let leaseId …`)
 * is the JOB layer's responsibility here — it must skip leases whose
 * `resman_lease_id` is empty before calling `upsertMirror`.
 */

import { numOrNull, parseLedgerDate, str } from "./parse";
import {
  mapVehicleRows,
  mapEmploymentRows,
  mapInsuranceRows,
  mapAddressRows,
  mapAlternateContactRows,
} from "./residents";
import type {
  ResmanLeaseRow,
  ResmanLeaseVehicleRow,
  ResmanLeaseEmploymentRow,
  ResmanLeaseInsuranceRow,
  ResmanLeaseAddressRow,
  ResmanLeaseAlternateContactRow,
} from "./types";

/** Grouped lease-tab output (see `mapLeaseTabs`). */
export interface MappedLeaseTabs {
  vehicles: ResmanLeaseVehicleRow[];
  employment: ResmanLeaseEmploymentRow[];
  insurance: ResmanLeaseInsuranceRow[];
  addresses: ResmanLeaseAddressRow[];
  alternateContacts: ResmanLeaseAlternateContactRow[];
}

// MARK: - Status predicates (used by the job layer too)

/**
 * True when the residency status still means an active lease (current, notice,
 * under eviction, MTM, …). False for completed states (past, evicted,
 * fulfilled, cancelled). Port of `isActiveLease(status:)` — note "under
 * eviction" is active because it does not contain "evicted".
 */
export function isActiveLease(status: string): boolean {
  const s = status.toLowerCase();
  return (
    !s.includes("past") &&
    !s.includes("evicted") &&
    !s.includes("fulfilled") &&
    !s.includes("cancelled")
  );
}

/** True when a lease dict represents a denied application. Port of `isDeniedLease`. */
export function isDeniedLease(data: Record<string, unknown>): boolean {
  return str(data, "status").toLowerCase().includes("denied");
}

/** True when a lease dict represents a pending application. Port of `isPendingLease`. */
export function isPendingLease(data: Record<string, unknown>): boolean {
  return str(data, "status").toLowerCase().includes("pending");
}

/**
 * Whole-word current/active match. Port of the Swift `isCurrent` computation in
 * `upsertLease` — avoids matching "Non-Current" / "Currently Evicted".
 */
function isCurrentStatus(statusStr: string): boolean {
  const sl = statusStr.toLowerCase();
  return (
    sl === "current" ||
    sl.startsWith("current ") ||
    sl.endsWith(" current") ||
    sl.includes(" current ") ||
    sl === "active" ||
    sl.startsWith("active ") ||
    sl.endsWith(" active") ||
    sl.includes(" active ")
  );
}

// MARK: - Lease

/**
 * Port of `upsertLease` (lease scalar fields only; residents and ledger are
 * mapped by `./residents` and `./ledger`). Returns a `ResmanLeaseRow` keyed on
 * `resman_lease_id`.
 *
 * `ctx.isMostRecent` is the caller's most-recent decision (the Swift loop marks
 * the first non-denied, non-pending lease); it is AND-ed with `!denied` exactly
 * as `lease.isMostRecentLease = isMostRecent && !denied`.
 */
/** A lease row with the two fields only the lease-history table can supply removed. */
export type LeaseRowWithoutTermDates = Omit<ResmanLeaseRow, "start_date" | "end_date">;

/**
 * Drop `start_date` / `end_date` so an upsert leaves those columns untouched.
 *
 * The lease TERM lives in the unit's lease-history table, not on the lease
 * detail page. `scrapeLeaseByPersonLeaseId` therefore feeds `mapLease` a
 * synthetic history row with `leaseStartDate: null, leaseEndDate: null` — it is
 * saying "I did not look", but `mapLease` cannot tell that from "there is no
 * term", so it emitted nulls and the upsert wrote them over real dates.
 *
 * That alone would self-heal on the next `unit-details` pass, which reads the
 * history table. It did not, because of what happens next: the nulled lease
 * still has a terminal status and now has `deep_synced_at` set, which is exactly
 * the archived-lease skip in `loadArchivedLeaseIds`. `unit-details` skips it
 * from then on and the nulls become permanent. 192 of 1,242 leases were stuck
 * that way on 2026-08-11 — every one terminal, every one deep-synced.
 *
 * Only these two fields are affected. `move_out_date`, `move_in_date`,
 * `application_date` and `signed_date` all come off the detail page for real:
 * measured against the damaged rows, move_out_date was present on 189 of 192 and
 * move_in_date on 192 of 192.
 *
 * Callers must apply this uniformly across an upsert batch. PostgREST builds one
 * statement from the union of keys in the batch, so a mix of stripped and
 * unstripped rows would put the nulls straight back.
 */
export function withoutTermDates(row: ResmanLeaseRow): LeaseRowWithoutTermDates {
  const { start_date: _startDate, end_date: _endDate, ...rest } = row;
  return rest;
}

/** A lease row with `balance` removed — see `withoutBalance`. */
export type LeaseRowWithoutBalance = Omit<ResmanLeaseRow, "balance">;

/**
 * Strip `balance` from a lease row, for the SHALLOW pass.
 *
 * Same trap as `withoutTermDates`, one column over. `unit-details` reads the
 * lease-history table and the resident page WITHOUT the ledger, so it never
 * sees a balance — but `mapLease` cannot tell "I did not look" from "there is
 * no balance" and emits null, which the upsert writes over whatever the deep
 * pass had recorded. Only the pass that actually reads the ledger may write
 * this column.
 *
 * Apply uniformly across the batch: PostgREST builds one statement from the
 * union of a batch's keys, so a single unstripped row puts the nulls back for
 * every row in it.
 */
/**
 * The columns a SKELETON lease row has no source for.
 *
 * `scrapeUnit` writes a skeleton for every non-current, non-terminal lease
 * (Pending, Notice to Vacate, Under Eviction, Month to Month) from the unit's
 * lease-history table alone. That table carries the status, the term dates,
 * the move-out date, the rent and the resident's name — and nothing else.
 * `mapLease` fills everything else with "" or null, and PostgREST writes those
 * blanks straight over whatever the DEEP pass had read from the resident page.
 *
 * Measured 2026-08-15: 40 of the 45 application leases had their leasing
 * agent, approval status and every date wiped this way. The deep pass had
 * captured them at 02:51 UTC; the unit pass overwrote them at 14:55. And once
 * overwritten they never recovered, because `leaseScrapeTier` returns "skip"
 * for a Pending lease that already carries `deep_synced_at` — so the blanks
 * were permanent.
 *
 * This is the same failure the balance and the term dates each had: a pass
 * writing a column it cannot observe.
 */
const SKELETON_UNOBSERVED_COLUMNS = [
  "unit_lease_group_id",
  "approval_status",
  "approved_date",
  "approved_by",
  "application_date",
  "signed_date",
  "move_in_date",
  "leasing_agent",
  "renewal_date",
  "notice_given_date",
  "market_rent",
  "hap_rent",
  "monthly_charge",
  "collection_balance",
  "reason_for_leaving",
  "original_start_date",
  "start_date_changes",
  "lease_sent_date",
  "lease_voided_date",
  "deposit_amount",
  "deposit_logged_date",
  "raw",
] as const;

export type LeaseRowFromSkeleton = Omit<
  ResmanLeaseRow,
  (typeof SKELETON_UNOBSERVED_COLUMNS)[number]
>;

/**
 * Drop every column the lease-history table cannot see, so a skeleton refresh
 * updates what it observed and leaves the rest alone. Keys are REMOVED, not
 * nulled: an absent key leaves the column untouched on upsert, a null key
 * overwrites it. That difference is the whole bug.
 */
export function withoutUnobservedFields(row: Record<string, unknown>): LeaseRowFromSkeleton {
  const out = { ...row };
  for (const column of SKELETON_UNOBSERVED_COLUMNS) delete out[column];
  return out as LeaseRowFromSkeleton;
}

/** The keys a skeleton lease dict genuinely carries, for the guard test. */
export const SKELETON_OBSERVED_COLUMNS = [
  "resman_lease_id",
  "resman_property_id",
  "resman_unit_id",
  "unit_number",
  "status",
  "start_date",
  "end_date",
  "move_out_date",
  "resident_rent",
  "is_current_lease",
  "is_most_recent_lease",
  "balance",
] as const;

export function withoutBalance(row: ResmanLeaseRow): LeaseRowWithoutBalance {
  const { balance: _balance, ...rest } = row;
  return rest;
}

/**
 * A lease's current balance, taken from its ledger.
 *
 * `mapLease` reads the balance from the detail page's `Balance` field, and that
 * field is not on the page — so every deep scrape wrote null and all 1,252
 * leases in the mirror carried a null balance. The delinquency view papered
 * over it by falling back to `unit.balance` for CURRENT leases, which left
 * every ended tenancy reporting an open balance of zero and understated the
 * bad-debt figures on the agent P&L.
 *
 * The ledger already has the answer and is already scraped. Each entry carries
 * the running balance after it, and `ledger_sequence` (assigned newest-highest
 * by mapLedgerRows) is the only reliable ordering — dates tie, and several
 * entries routinely share one. So the newest entry's balance IS the lease
 * balance. Checked against the four largest debtors on the property: the last
 * entry matched `resman_units.balance` to the cent (8165.75, 6640.20, 6349.40,
 * 6238.20), while naively summing charges minus credits was $300 out on three
 * of them — an opening balance the visible entries do not carry.
 *
 * No ledger means no money has ever moved on the lease, which is a balance of
 * zero, not "unknown". Never null: a lease always has a balance.
 */
export function leaseBalanceFromLedger(
  ledgerRows: readonly { balance: number | null; ledger_sequence: number }[],
): number {
  let newest: { balance: number | null; ledger_sequence: number } | null = null;
  for (const row of ledgerRows) {
    if (newest === null || row.ledger_sequence > newest.ledger_sequence) newest = row;
  }
  return newest?.balance ?? 0;
}

export function mapLease(
  leaseData: Record<string, unknown>,
  ctx: { unitId: string; unitNumber: string; propertyId: string; isMostRecent: boolean },
): ResmanLeaseRow {
  const statusStr = str(leaseData, "status");
  const denied = statusStr.toLowerCase().includes("denied");

  return {
    resman_lease_id: str(leaseData, "leaseId"),
    unit_lease_group_id: str(leaseData, "unitLeaseGroupId"),
    resman_property_id: ctx.propertyId,
    resman_unit_id: ctx.unitId,
    unit_number: ctx.unitNumber,
    status: statusStr,
    approval_status: str(leaseData, "approvalStatus"),
    // From the Activity Log, the only place ResMan records WHEN an application
    // was approved — there is no approval-date field on any page.
    approved_date: parseLedgerDate(str(leaseData, "approvedDate")),
    approved_by: str(leaseData, "approvedBy"),
    // The start date the lease FIRST had, and how many times it has moved —
    // both from the Activity Log. A desired move-in that keeps sliding looks
    // identical to a firm one without them.
    original_start_date: parseLedgerDate(str(leaseData, "originalStartDate")),
    start_date_changes: numOrNull(leaseData["startDateChanges"]) ?? 0,
    lease_sent_date: parseLedgerDate(str(leaseData, "leaseSentDate")),
    lease_voided_date: parseLedgerDate(str(leaseData, "leaseVoidedDate")),
    // The security deposit, also from the Activity Log — no page states it.
    // Null means the log has no "Added Security Deposit" line, which is a
    // deposit that was never taken (19 of the 45 applications), not an unknown.
    deposit_amount: numOrNull(leaseData["depositAmount"]),
    deposit_logged_date: parseLedgerDate(str(leaseData, "depositLoggedDate")),
    application_date: parseLedgerDate(str(leaseData, "applicationDate")),
    signed_date: parseLedgerDate(str(leaseData, "leaseSignedDate")),
    start_date: parseLedgerDate(str(leaseData, "leaseStartDate")),
    end_date: parseLedgerDate(str(leaseData, "leaseEndDate")),
    move_in_date: parseLedgerDate(str(leaseData, "moveInDate")),
    move_out_date: parseLedgerDate(str(leaseData, "moveOutDate")),
    leasing_agent: str(leaseData, "leasingAgent"),
    renewal_date: parseLedgerDate(str(leaseData, "renewalDate")),
    notice_given_date: parseLedgerDate(str(leaseData, "noticeGivenDate")),
    market_rent: numOrNull(leaseData["marketRent"]),
    resident_rent: numOrNull(leaseData["residentRent"]),
    hap_rent: numOrNull(leaseData["hapRent"]),
    monthly_charge: numOrNull(leaseData["monthlyCharge"]),
    balance: numOrNull(leaseData["balance"]),
    collection_balance: numOrNull(leaseData["collectionBalance"]),
    reason_for_leaving: str(leaseData, "reasonForLeaving"),
    is_current_lease: !denied && isCurrentStatus(statusStr),
    is_most_recent_lease: ctx.isMostRecent && !denied,
    raw: leaseData,
  };
}

/**
 * Map lease-dict-top-level tab arrays (when a scrape path surfaces them there)
 * into rows attributed to the primary `personLeaseId`. Mirrors the per-person
 * tab extraction in `applyLeaseTabData`/`upsertResidents`: a tab array is mapped
 * only when its key is present, otherwise an empty array is returned so the job
 * can distinguish "not fetched" (leave existing rows) from an actual empty set.
 */
export function mapLeaseTabs(
  leaseData: Record<string, unknown>,
  personLeaseId = "",
): MappedLeaseTabs {
  return {
    vehicles: mapTab(leaseData, "vehicles", personLeaseId, mapVehicleRows),
    employment: mapTab(leaseData, "employment", personLeaseId, mapEmploymentRows),
    insurance: mapTab(leaseData, "insurance", personLeaseId, mapInsuranceRows),
    addresses: mapTab(leaseData, "addresses", personLeaseId, mapAddressRows),
    alternateContacts: mapTab(leaseData, "alternateContacts", personLeaseId, mapAlternateContactRows),
  };
}

/** Map one named tab array off a dict, or [] when the key is absent. */
function mapTab<R>(
  dict: Record<string, unknown>,
  key: string,
  personLeaseId: string,
  fn: (rows: Record<string, unknown>[], personLeaseId: string) => R[],
): R[] {
  const value = dict[key];
  if (!Array.isArray(value)) return [];
  const rows = value.filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
  return fn(rows, personLeaseId);
}

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

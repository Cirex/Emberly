import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Chunky lease mirror for the manager app. The phone pulls the last 24 months
 * of leases (plus anything still current) in one shot and derives the
 * Pipeline / Expirations / Forecast boards and agent scorecards on device —
 * the server does no board math here.
 */

type LeaseRow = Database["public"]["Tables"]["resman_leases"]["Row"];

/** The resman_leases columns the manager payload carries. */
export const MANAGER_LEASE_COLUMNS =
  "resman_lease_id, resman_unit_id, unit_number, status, approval_status, application_date, " +
  "signed_date, start_date, end_date, move_in_date, move_out_date, leasing_agent, " +
  "market_rent, resident_rent, balance, is_current_lease, is_most_recent_lease";

export type ManagerLeaseRow = Pick<
  LeaseRow,
  | "resman_lease_id"
  | "resman_unit_id"
  | "unit_number"
  | "status"
  | "approval_status"
  | "application_date"
  | "signed_date"
  | "start_date"
  | "end_date"
  | "move_in_date"
  | "move_out_date"
  | "leasing_agent"
  | "market_rent"
  | "resident_rent"
  | "balance"
  | "is_current_lease"
  | "is_most_recent_lease"
>;

/** One lease, camelCased for the wire. */
export interface ManagerLeasePayload {
  id: string;
  unitId: string | null;
  unitNumber: string;
  status: string;
  approvalStatus: string;
  applicationDate: string | null;
  signedDate: string | null;
  startDate: string | null;
  endDate: string | null;
  moveInDate: string | null;
  moveOutDate: string | null;
  leasingAgent: string;
  marketRent: number | null;
  residentRent: number | null;
  balance: number | null;
  isCurrentLease: boolean;
  isMostRecentLease: boolean;
}

export function managerLeasePayload(row: ManagerLeaseRow): ManagerLeasePayload {
  return {
    id: row.resman_lease_id,
    unitId: row.resman_unit_id,
    unitNumber: row.unit_number,
    status: row.status,
    approvalStatus: row.approval_status,
    applicationDate: row.application_date,
    signedDate: row.signed_date,
    startDate: row.start_date,
    endDate: row.end_date,
    moveInDate: row.move_in_date,
    moveOutDate: row.move_out_date,
    leasingAgent: row.leasing_agent,
    marketRent: row.market_rent,
    residentRent: row.resident_rent,
    balance: row.balance,
    isCurrentLease: row.is_current_lease,
    isMostRecentLease: row.is_most_recent_lease,
  };
}

/** "YYYY-MM-DD" exactly `months` calendar months before `nowMs` (UTC). */
export function monthsAgoIsoDate(nowMs: number, months: number): string {
  const now = new Date(nowMs);
  const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return shifted.toISOString().slice(0, 10);
}

/**
 * PostgREST `or=` expression selecting the manager window: any lease whose
 * application/start/move-in landed within the window, plus anything still
 * current regardless of age (long-tenured residents must not drop off).
 */
export function recentLeaseOrFilter(cutoffIsoDate: string): string {
  return (
    `is_current_lease.eq.true,application_date.gte.${cutoffIsoDate},` +
    `start_date.gte.${cutoffIsoDate},move_in_date.gte.${cutoffIsoDate}`
  );
}

/** Leases from the last 24 months (or still current), newest start first. */
export async function listManagerLeases(
  client: UntypedSupabase,
  nowMs: number = Date.now(),
): Promise<ManagerLeasePayload[]> {
  const cutoff = monthsAgoIsoDate(nowMs, 24);
  const { data, error } = await client
    .from("resman_leases")
    .select(MANAGER_LEASE_COLUMNS)
    .or(recentLeaseOrFilter(cutoff))
    .order("start_date", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ManagerLeaseRow[]).map(managerLeasePayload);
}

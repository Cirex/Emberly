import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";
import { monthsAgoIsoDate } from "@/lib/manager-leases";

/**
 * Daily property snapshots for the manager app's Trends charts. The sync
 * worker writes one public.property_snapshots row per day (nightly job, plus
 * a one-shot lease-span occupancy backfill); this module reads a window of
 * them back out, oldest first, as camelCase DTOs. Metric columns are nullable
 * on purpose — a null means "series not yet begun" and the phone labels the
 * honest series start instead of charting a fake flat past.
 */

type SnapshotRow = Database["public"]["Tables"]["property_snapshots"]["Row"];

/** Window bounds: default 12 months of history, capped at the 24 the backfill
 *  reconstructs. */
export const SNAPSHOT_MONTHS_DEFAULT = 12;
export const SNAPSHOT_MONTHS_CAP = 24;

/**
 * Parse the ?months= query value: default 12, clamped to [1, 24]. Anything
 * unparseable falls back to the default rather than erroring — a bad range is
 * a UI bug, not a reason to blank the charts.
 */
export function clampSnapshotMonths(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SNAPSHOT_MONTHS_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return SNAPSHOT_MONTHS_DEFAULT;
  return Math.min(SNAPSHOT_MONTHS_CAP, Math.max(1, Math.trunc(value)));
}

/** The property_snapshots columns the manager payload carries. */
export const MANAGER_SNAPSHOT_COLUMNS =
  "snapshot_date, total_units, occupied_units, vacant_units, occupancy_pct, " +
  "rent_roll, lease_rent_total, balance_total, balance_0_30, balance_31_60, " +
  "balance_61_90, balance_90_plus, delinquent_units, turns_in_progress, " +
  "open_work_orders, utility_due, source";

export type ManagerSnapshotRow = Pick<
  SnapshotRow,
  | "snapshot_date"
  | "total_units"
  | "occupied_units"
  | "vacant_units"
  | "occupancy_pct"
  | "rent_roll"
  | "lease_rent_total"
  | "balance_total"
  | "balance_0_30"
  | "balance_31_60"
  | "balance_61_90"
  | "balance_90_plus"
  | "delinquent_units"
  | "turns_in_progress"
  | "open_work_orders"
  | "utility_due"
  | "source"
>;

/** One snapshot day, camelCased for the wire. */
export interface ManagerSnapshotPayload {
  date: string;
  totalUnits: number | null;
  occupiedUnits: number | null;
  vacantUnits: number | null;
  occupancyPct: number | null;
  rentRoll: number | null;
  leaseRentTotal: number | null;
  balanceTotal: number | null;
  balance0To30: number | null;
  balance31To60: number | null;
  balance61To90: number | null;
  balance90Plus: number | null;
  delinquentUnits: number | null;
  turnsInProgress: number | null;
  openWorkOrders: number | null;
  utilityDue: number | null;
  source: "nightly" | "backfill";
}

export function managerSnapshotPayload(row: ManagerSnapshotRow): ManagerSnapshotPayload {
  return {
    date: row.snapshot_date,
    totalUnits: row.total_units,
    occupiedUnits: row.occupied_units,
    vacantUnits: row.vacant_units,
    occupancyPct: row.occupancy_pct,
    rentRoll: row.rent_roll,
    leaseRentTotal: row.lease_rent_total,
    balanceTotal: row.balance_total,
    balance0To30: row.balance_0_30,
    balance31To60: row.balance_31_60,
    balance61To90: row.balance_61_90,
    balance90Plus: row.balance_90_plus,
    delinquentUnits: row.delinquent_units,
    turnsInProgress: row.turns_in_progress,
    openWorkOrders: row.open_work_orders,
    utilityDue: row.utility_due,
    source: row.source,
  };
}

/** Snapshots from the last `months` calendar months, oldest first. One row per
 *  day caps this at ~730 rows, comfortably under PostgREST's 1000-row page. */
export async function listManagerSnapshots(
  client: UntypedSupabase,
  months: number,
  nowMs: number = Date.now(),
): Promise<ManagerSnapshotPayload[]> {
  const cutoff = monthsAgoIsoDate(nowMs, months);
  const { data, error } = await client
    .from("property_snapshots")
    .select(MANAGER_SNAPSHOT_COLUMNS)
    .gte("snapshot_date", cutoff)
    .order("snapshot_date", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ManagerSnapshotRow[]).map(managerSnapshotPayload);
}

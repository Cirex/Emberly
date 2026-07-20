/**
 * Enumeration contracts for the ResMan (resman_*) + MLGW (mlgw_*) sync-mirror
 * tables. These mirror the `check` constraints in
 * apps/web/lib/supabase/schema.sql
 * and are shared by both the sync worker (emberly-sync, which upserts rows)
 * and emberly-web (the future read-only REST API / MCP server, which validates
 * and filters on them). Changing a value here is a schema-contract change and
 * must be accompanied by a migration to the matching check constraint.
 */

/** OccupancyStatus — resman_units.occupancy_status (derived from lease_status). */
export const RESMAN_OCCUPANCY_STATUSES = ["Occupied", "Vacant", "Notice"] as const;
export type ResmanOccupancyStatus = (typeof RESMAN_OCCUPANCY_STATUSES)[number];

/** LeaseStatus — resman_units.lease_status (null = unknown). */
export const RESMAN_LEASE_STATUSES = [
  "Current",
  "Under Eviction",
  "Notice to Vacate",
  "Month to Month",
  "Pending",
  "Pending Renewal",
  "Cancelled",
] as const;
export type ResmanLeaseStatus = (typeof RESMAN_LEASE_STATUSES)[number];

/** WorkOrderStatus — resman_work_orders.status. */
export const RESMAN_WORK_ORDER_STATUSES = [
  "Not Started",
  "Scheduled",
  "In Progress",
  "Completed",
  "Closed",
  "Canceled",
] as const;
export type ResmanWorkOrderStatus = (typeof RESMAN_WORK_ORDER_STATUSES)[number];

/** WorkOrderPriority — resman_work_orders.priority. */
export const RESMAN_WORK_ORDER_PRIORITIES = [
  "Emergency",
  "High",
  "Normal",
  "Low",
] as const;
export type ResmanWorkOrderPriority = (typeof RESMAN_WORK_ORDER_PRIORITIES)[number];

/** WorkOrderCallbackStatus — resman_work_orders.callback_status. */
export const RESMAN_WORK_ORDER_CALLBACK_STATUSES = [
  "none",
  "possible",
  "confirmed",
  "dismissed",
] as const;
export type ResmanWorkOrderCallbackStatus =
  (typeof RESMAN_WORK_ORDER_CALLBACK_STATUSES)[number];

/** Sync-run status — resman_sync_runs.status. */
export const RESMAN_SYNC_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "partial",
  "skipped",
] as const;
export type ResmanSyncRunStatus = (typeof RESMAN_SYNC_RUN_STATUSES)[number];

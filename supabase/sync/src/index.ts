/**
 * @emberly/sync — ResMan + MLGW sync worker.
 *
 * This package is the TypeScript port of the Swift "Kraken" package
 * (KrakenCore). It scrapes ResMan (property management) and MLGW (utility
 * billing) and upserts the results into the emberly-web Supabase project's
 * resman_* / mlgw_* mirror tables. It runs as a long-lived worker on Coolify
 * (never Vercel serverless — the jobs run for minutes and hold stateful
 * cookie sessions).
 */

export const PACKAGE_NAME = "@emberly/sync";

// Re-export the shared enum contracts so both the sync worker and emberly-web
// consume one source of truth for the resman_*/mlgw_* check-constraint values.
export {
  RESMAN_OCCUPANCY_STATUSES,
  RESMAN_LEASE_STATUSES,
  RESMAN_WORK_ORDER_STATUSES,
  RESMAN_WORK_ORDER_PRIORITIES,
  RESMAN_WORK_ORDER_CALLBACK_STATUSES,
  RESMAN_SYNC_RUN_STATUSES,
} from "@emberly/core";
export type {
  ResmanOccupancyStatus,
  ResmanLeaseStatus,
  ResmanWorkOrderStatus,
  ResmanWorkOrderPriority,
  ResmanWorkOrderCallbackStatus,
  ResmanSyncRunStatus,
} from "@emberly/core";

// Milestone 2: ResMan shared primitives (client/session/scheduler/csv/reports/normalize).
export * from "./resman";

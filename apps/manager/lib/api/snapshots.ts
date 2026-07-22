import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Daily property snapshot reads for the Trends charts.
 *
 *   GET /api/resman/manager/snapshots?months=24 → one row per day, oldest
 *   first: occupancy family, rent roll, balances by aging bucket, delinquent
 *   units, turns in progress, open work orders, utility due.
 *
 * NULL CONTRACT ("honest backfill"): every metric is nullable. Occupancy was
 * reconstructed from lease spans, so that family is full-depth; balances and
 * the rest are null before the nightly job first ran, and the charts label
 * the series start rather than faking a flat past. The app always fetches the
 * 24-month cap and slices ranges (12m / 3m / 30d) locally.
 */

const metric = z.number().nullable().default(null);

export const SnapshotSchema = z.object({
  /** "YYYY-MM-DD" — the property-local snapshot day. */
  date: z.string(),
  totalUnits: metric,
  occupiedUnits: metric,
  vacantUnits: metric,
  occupancyPct: metric,
  rentRoll: metric,
  leaseRentTotal: metric,
  balanceTotal: metric,
  balance0To30: metric,
  balance31To60: metric,
  balance61To90: metric,
  balance90Plus: metric,
  delinquentUnits: metric,
  turnsInProgress: metric,
  openWorkOrders: metric,
  utilityDue: metric,
  source: z.enum(["nightly", "backfill"]).default("nightly"),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

const EnvelopeSchema = z.object({ data: z.object({ snapshots: z.array(SnapshotSchema) }) });

/** The full 24-month snapshot window, oldest first. Throws ApiError / ZodError;
 *  callers contain. */
export async function fetchSnapshots(
  config: StaffConfig,
  months = 24,
): Promise<Snapshot[]> {
  const json = await apiJson(`/api/resman/manager/snapshots?months=${months}`, config);
  return EnvelopeSchema.parse(json).data.snapshots;
}

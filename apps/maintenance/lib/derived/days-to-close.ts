import type { ParsedWorkOrder } from "./types";

/**
 * Days-to-close histogram. Port of the Swift closed-mode distribution panel:
 * closed orders bucketed by whole days from reported→completed into five fixed
 * ranges. The buckets are always emitted (zero-filled, stable order) so the
 * chart never reflows as filters change.
 */

export interface DaysToCloseBucket {
  key: "0-2" | "3-7" | "8-14" | "15-30" | "31+";
  caption: string;
  count: number;
}

export interface DaysToCloseMetrics {
  totalClosed: number;
  /** Highest-count bucket; FIRST bucket wins ties; null when nothing counted. */
  dominantBucket: DaysToCloseBucket | null;
}

const BUCKET_DEFS: { key: DaysToCloseBucket["key"]; caption: string; max: number }[] = [
  { key: "0-2", caption: "Closed within 2 days", max: 2 },
  { key: "3-7", caption: "Closed in 3 to 7 days", max: 7 },
  { key: "8-14", caption: "Closed in 8 to 14 days", max: 14 },
  { key: "15-30", caption: "Closed in 15 to 30 days", max: 30 },
  { key: "31+", caption: "Closed in 31 or more days", max: Number.POSITIVE_INFINITY },
];

/**
 * Input is the closed-mode filtered set; only rows with BOTH dates count
 * (daysToComplete is precomputed in parse and already clamped to ≥ 0).
 */
export function buildDaysToCloseDistribution(closedWorkOrders: ParsedWorkOrder[]): {
  buckets: DaysToCloseBucket[];
  metrics: DaysToCloseMetrics;
} {
  const buckets: DaysToCloseBucket[] = BUCKET_DEFS.map((def) => ({
    key: def.key,
    caption: def.caption,
    count: 0,
  }));

  for (const wo of closedWorkOrders) {
    if (wo.reportedAt === null || wo.completedAt === null || wo.daysToComplete === null) continue;
    const days = wo.daysToComplete;
    // Ranges are inclusive; the first bucket whose max covers `days` wins.
    const index = BUCKET_DEFS.findIndex((def) => days <= def.max);
    buckets[index].count += 1;
  }

  const totalClosed = buckets.reduce((sum, b) => sum + b.count, 0);
  let dominantBucket: DaysToCloseBucket | null = null;
  if (totalClosed > 0) {
    // Strict > keeps the FIRST bucket on ties.
    for (const bucket of buckets) {
      if (dominantBucket === null || bucket.count > dominantBucket.count) dominantBucket = bucket;
    }
  }

  return { buckets, metrics: { totalClosed, dominantBucket } };
}

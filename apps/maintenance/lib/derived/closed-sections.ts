import type { ClosedWorkOrderRow } from "./closed-rows";
import { axesOf, type SortField } from "./sort-axes";
import type { WorkOrderSortOption } from "./sort";

/**
 * Day groups for the closed board — "TODAY · 2", "THIS WEEK",
 * "EARLIER THIS MONTH · 37", "OLDER".
 *
 * Closed work is scanned for recency ("what did we finish?"), so the timeline is
 * the spine rather than a column. Counts per band give the header's
 * closed-this-week figure a shape.
 *
 * GROUPING IS CONDITIONAL, which the design did not have to consider because it
 * assumed the default ordering. Day bands only describe a list ordered BY DATE.
 * Sorted by unit or id, a "Today" band would contain whichever rows happened to
 * fall there and the header would be a lie — so a non-date sort renders flat.
 */

export type ClosedBandKey = "today" | "thisWeek" | "earlierThisMonth" | "older" | "undated";

export interface ClosedSection {
  key: ClosedBandKey;
  /** i18n key stem under `workOrders.closed.band`. */
  labelKey: ClosedBandKey;
  count: number;
  /** Named `data` because SectionList requires that key — no adapter layer. */
  data: ClosedWorkOrderRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight for a timestamp — bands are calendar days, not 24h windows. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Which band a completion date falls in.
 *
 * Deliberately calendar-based, not "within N × 24h": something closed at 11pm
 * yesterday is Yesterday to a person even though it is two hours ago. "This
 * week" is the last seven calendar days excluding today, so the bands never
 * overlap and every row lands in exactly one.
 */
export function bandFor(completedMs: number | null, nowMs: number): ClosedBandKey {
  if (completedMs === null) return "undated";
  const today = startOfDay(nowMs);
  const day = startOfDay(completedMs);
  if (day >= today) return "today";
  if (day > today - 7 * DAY_MS) return "thisWeek";
  const monthStart = new Date(nowMs);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  if (day >= monthStart.getTime()) return "earlierThisMonth";
  return "older";
}

const BAND_ORDER: ClosedBandKey[] = ["today", "thisWeek", "earlierThisMonth", "older", "undated"];

/** True when the ordering makes day bands meaningful at all. */
export function groupsApplyTo(option: WorkOrderSortOption): boolean {
  const field: SortField = axesOf(option).field;
  return field === "dateCompleted";
}

/**
 * Group rows into bands, preserving the order they arrive in.
 *
 * Rows are already sorted by the caller, so this only partitions — it never
 * re-sorts. Empty bands are dropped rather than rendered as a header with
 * nothing beneath it.
 */
export function buildClosedSections(
  rows: readonly ClosedWorkOrderRow[],
  nowMs: number,
): ClosedSection[] {
  const buckets = new Map<ClosedBandKey, ClosedWorkOrderRow[]>();
  for (const row of rows) {
    const key = bandFor(row.dateCompletedMs, nowMs);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  return BAND_ORDER.filter((key) => (buckets.get(key)?.length ?? 0) > 0).map((key) => {
    const bucket = buckets.get(key) ?? [];
    return { key, labelKey: key, count: bucket.length, data: bucket };
  });
}

/**
 * One section holding everything, for orderings where bands would mislead.
 * Returned rather than a null so the screen renders one list either way.
 */
export function singleClosedSection(rows: readonly ClosedWorkOrderRow[]): ClosedSection[] {
  if (rows.length === 0) return [];
  return [{ key: "older", labelKey: "older", count: rows.length, data: [...rows] }];
}

import type { DisplayMode } from "./types";
import { sortOptionsFor, type WorkOrderSortOption } from "./sort";

/**
 * Sort as two axes: WHAT to order by, and WHICH WAY.
 *
 * The stored value stays a flat union (`WorkOrderSortOption`) because it is
 * persisted. This module is the presentation view of it — and it exists because
 * rendering twelve flat options as twelve equal pills is what made the filter
 * sheet clunky: four wrapping rows for a single choice, with the selection
 * distinguishable only by fill.
 *
 * Split apart, it is five or six fields on one row and a direction on another,
 * which is both smaller and more capable: three fields previously had only one
 * direction available, so "oldest completed first" — the way you find work that
 * sat — was unreachable.
 *
 * Pure: no React, no i18n. Labels are keys the caller translates.
 */

export type SortField = "dateCompleted" | "dateReported" | "recentMoveIn" | "status" | "unit";
export type SortDirection = "asc" | "desc";

/** Every option, decomposed. The single source of truth for both directions. */
const AXES: Record<WorkOrderSortOption, { field: SortField; direction: SortDirection }> = {
  dateCompletedDescending: { field: "dateCompleted", direction: "desc" },
  dateCompletedAscending: { field: "dateCompleted", direction: "asc" },
  dateReportedDescending: { field: "dateReported", direction: "desc" },
  dateReportedAscending: { field: "dateReported", direction: "asc" },
  recentMoveInDescending: { field: "recentMoveIn", direction: "desc" },
  recentMoveInAscending: { field: "recentMoveIn", direction: "asc" },
  statusDescending: { field: "status", direction: "desc" },
  statusAscending: { field: "status", direction: "asc" },
  unitDescending: { field: "unit", direction: "desc" },
  unitAscending: { field: "unit", direction: "asc" },
};

/** Display order of the field control. */
const FIELD_ORDER: SortField[] = ["dateCompleted", "dateReported", "status", "unit", "recentMoveIn"];

export function axesOf(option: WorkOrderSortOption): { field: SortField; direction: SortDirection } {
  return AXES[option];
}

/** The stored option for a field + direction. Total — every pair now exists. */
export function optionFor(field: SortField, direction: SortDirection): WorkOrderSortOption {
  const found = (Object.keys(AXES) as WorkOrderSortOption[]).find(
    (o) => AXES[o].field === field && AXES[o].direction === direction,
  );
  // Unreachable: AXES covers all 6 x 2. Falls back rather than throwing, since a
  // sort control is not worth crashing a technician's board over.
  return found ?? "dateReportedDescending";
}

/** Fields offered in this display mode, in display order. */
export function sortFieldsFor(mode: DisplayMode): SortField[] {
  const available = new Set(sortOptionsFor(mode).map((o) => AXES[o].field));
  return FIELD_ORDER.filter((f) => available.has(f));
}

/**
 * i18n key stems for a field's two directions.
 *
 * Direction reads in the FIELD's own language rather than as "Ascending" — a
 * date is newest/oldest, an id is low→high, a status is A→Z. "Date Completed:
 * Ascending" is a sentence a technician has to decode.
 */
export function directionKeys(field: SortField): { asc: string; desc: string } {
  switch (field) {
    case "dateCompleted":
    case "dateReported":
      return { desc: "newestFirst", asc: "oldestFirst" };
    case "recentMoveIn":
      return { desc: "newestResidents", asc: "longestTenured" };
    case "status":
      return { asc: "aToZ", desc: "zToA" };
    case "unit":
      return { asc: "lowToHigh", desc: "highToLow" };
  }
}

/** i18n key stem for a field's own label. */
export function fieldKey(field: SortField): string {
  return field;
}

/**
 * Keep the current field when the mode changes if it still exists, otherwise
 * fall back — switching to Closed must not silently strand a move-in sort.
 */
export function reconcileForMode(
  option: WorkOrderSortOption,
  mode: DisplayMode,
): WorkOrderSortOption {
  if (sortOptionsFor(mode).includes(option)) return option;
  const { direction } = AXES[option];
  const fallback = sortFieldsFor(mode)[0] ?? "dateReported";
  return optionFor(fallback, direction);
}

/**
 * Reconcile a value read back from disk.
 *
 * The sort option is persisted, so a device can hold an option this build no
 * longer has — an id sort, or a completion sort on the open board, both retired
 * because neither ordered anything a technician could use. `axesOf` would return
 * undefined for those and the filter sheet would crash reading `.field`, so
 * anything unrecognised is dropped to the board's own default rather than
 * trusted. Direction survives when the value merely moved out of the mode.
 */
export function sanitizeSortOption(value: unknown, mode: DisplayMode): WorkOrderSortOption {
  if (typeof value !== "string" || !(value in AXES)) {
    // The board's natural default, newest first — NOT sortOptionsFor(mode)[0],
    // whose order is the ported Swift enum's and means nothing.
    return optionFor(sortFieldsFor(mode)[0] ?? "dateReported", "desc");
  }
  return reconcileForMode(value as WorkOrderSortOption, mode);
}

export { AXES as SORT_AXES, FIELD_ORDER as SORT_FIELD_ORDER };

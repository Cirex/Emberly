import type { DisplayMode, ParsedWorkOrder, UnitIndex } from "./types";

/**
 * Sort options + row comparators — port of WorkOrderSortOption (Swift, 9
 * cases). Group-level sorting lives in open-groups.ts (it needs the group
 * shape; keeping it there keeps the import chain acyclic:
 * types → filtering → sort → open-groups → closed-rows).
 */

/**
 * The persisted sort value. Stays a flat union because it is written to disk —
 * the UI presents it as a FIELD plus a DIRECTION (see sort-axes.ts), which is
 * a presentation concern, not a storage one.
 *
 * The matrix used to have holes: date-completed had no ascending, unit had no
 * descending, move-in had no ascending. Every field now has both, so the
 * direction control is never disabled and "oldest completed first" — the way you
 * find work that sat — is reachable.
 *
 * SORTING BY ID IS GONE. Work-order numbers are issued in reported order, so
 * "ID: Newest" was a second, less legible copy of "Reported: Newest" — and when
 * ResMan's numbering skipped a block, a misleading one. Legacy persisted values
 * are reconciled on rehydrate (see sanitizeSortOption).
 */
export type WorkOrderSortOption =
  | "dateCompletedDescending"
  | "dateCompletedAscending"
  | "dateReportedDescending"
  | "dateReportedAscending"
  | "recentMoveInDescending"
  | "recentMoveInAscending"
  | "statusAscending"
  | "statusDescending"
  | "unitAscending"
  | "unitDescending";

const ALL_SORT_OPTIONS: WorkOrderSortOption[] = [
  "dateCompletedDescending",
  "dateCompletedAscending",
  "recentMoveInAscending",
  "unitDescending",
  "dateReportedDescending",
  "dateReportedAscending",
  "recentMoveInDescending",
  "statusAscending",
  "statusDescending",
  "unitAscending",
];

const COMPLETION_SORTS: WorkOrderSortOption[] = [
  "dateCompletedDescending",
  "dateCompletedAscending",
];
const MOVE_IN_SORTS: WorkOrderSortOption[] = ["recentMoveInDescending", "recentMoveInAscending"];

/**
 * Which orderings a board can offer.
 *
 * Completion date is CLOSED-ONLY: open work has no completion date, so every row
 * shares the same missing-date sentinel and the ordering collapses to whatever
 * the tiebreak happens to be — a control that looks like it sorts and doesn't.
 * Move-in only means something on the open board's unit groups.
 */
export function sortOptionsFor(mode: DisplayMode): WorkOrderSortOption[] {
  return ALL_SORT_OPTIONS.filter((option) => {
    if (COMPLETION_SORTS.includes(option)) return mode === "closed";
    if (MOVE_IN_SORTS.includes(option)) return mode === "open";
    return true;
  });
}

/**
 * Comparison-based number ordering — NOT subtraction, because missing dates
 * become ±Infinity sentinels and (Infinity - Infinity) is NaN, which would
 * make Array.sort nondeterministic.
 */
export function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Plain lexicographic compare — mirror of Swift's `<` on String. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Numeric-aware string compare ("2" < "10") — mirrors localizedStandardCompare. */
export function compareNumericStrings(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Move-in recency key: move-in date, else lease start, else -Infinity so
 * unitless/undated rows sort LAST on the descending board.
 */
export function recentMoveInSort(wo: ParsedWorkOrder, unitIndex: UnitIndex): number {
  const facts = unitIndex.get(wo.unitNumber);
  return facts?.moveInAt ?? facts?.leaseStartAt ?? -Infinity;
}

/** Within-a-unit-group row ordering for the open board. Returns a new array. */
export function sortOpenWorkOrders(
  workOrders: ParsedWorkOrder[],
  option: WorkOrderSortOption,
  unitIndex: UnitIndex,
): ParsedWorkOrder[] {
  const byReportedDesc = (a: ParsedWorkOrder, b: ParsedWorkOrder) =>
    compareNumbers(b.reportedAt ?? -Infinity, a.reportedAt ?? -Infinity);
  const sorted = [...workOrders];
  switch (option) {
    case "dateReportedAscending":
      sorted.sort((a, b) => compareNumbers(a.reportedAt ?? Infinity, b.reportedAt ?? Infinity));
      break;
    case "recentMoveInDescending":
      sorted.sort(
        (a, b) =>
          compareNumbers(recentMoveInSort(b, unitIndex), recentMoveInSort(a, unitIndex)) ||
          byReportedDesc(a, b),
      );
      break;
    case "statusAscending":
      sorted.sort((a, b) => compareStrings(a.status, b.status) || byReportedDesc(a, b));
      break;
    case "statusDescending":
      sorted.sort((a, b) => compareStrings(b.status, a.status) || byReportedDesc(a, b));
      break;
    case "unitAscending":
      sorted.sort((a, b) => compareNumericStrings(a.unitNumber, b.unitNumber) || byReportedDesc(a, b));
      break;
    case "unitDescending":
      sorted.sort((a, b) => compareNumericStrings(b.unitNumber, a.unitNumber) || byReportedDesc(a, b));
      break;
    case "recentMoveInAscending":
      sorted.sort(
        (a, b) =>
          compareNumbers(recentMoveInSort(a, unitIndex), recentMoveInSort(b, unitIndex)) ||
          byReportedDesc(a, b),
      );
      break;
    case "dateCompletedAscending":
    case "dateCompletedDescending":
    case "dateReportedDescending":
      // The open board has no completed dates, so both fall back to reported-newest.
      sorted.sort(byReportedDesc);
      break;
  }
  return sorted;
}

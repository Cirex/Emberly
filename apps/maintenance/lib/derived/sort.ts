import type { DisplayMode, ParsedWorkOrder, UnitIndex } from "./types";

/**
 * Sort options + row comparators — port of WorkOrderSortOption (Swift, 9
 * cases). Group-level sorting lives in open-groups.ts (it needs the group
 * shape; keeping it there keeps the import chain acyclic:
 * types → filtering → sort → open-groups → closed-rows).
 */

export type WorkOrderSortOption =
  | "dateCompletedDescending"
  | "dateReportedDescending"
  | "dateReportedAscending"
  | "recentMoveInDescending"
  | "idAscending"
  | "idDescending"
  | "statusAscending"
  | "statusDescending"
  | "unitAscending";

export const SORT_LABELS: Record<WorkOrderSortOption, string> = {
  dateCompletedDescending: "Date Completed: Newest",
  dateReportedDescending: "Date Reported: Newest",
  dateReportedAscending: "Date Reported: Oldest",
  recentMoveInDescending: "Recent Move-Ins",
  idAscending: "ID: Ascending",
  idDescending: "ID: Descending",
  statusAscending: "Status: Ascending",
  statusDescending: "Status: Descending",
  unitAscending: "Unit: Ascending",
};

const ALL_SORT_OPTIONS: WorkOrderSortOption[] = [
  "dateCompletedDescending",
  "dateReportedDescending",
  "dateReportedAscending",
  "recentMoveInDescending",
  "idAscending",
  "idDescending",
  "statusAscending",
  "statusDescending",
  "unitAscending",
];

/** Move-in sorting only means something on the open board's unit groups. */
export function sortOptionsFor(mode: DisplayMode): WorkOrderSortOption[] {
  if (mode === "open") return [...ALL_SORT_OPTIONS];
  return ALL_SORT_OPTIONS.filter((option) => option !== "recentMoveInDescending");
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
    case "idAscending":
      sorted.sort((a, b) => compareNumericStrings(a.number, b.number));
      break;
    case "idDescending":
      sorted.sort((a, b) => compareNumericStrings(b.number, a.number));
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
    case "dateCompletedDescending":
    case "dateReportedDescending":
      // The open board has no completed dates, so both fall back to reported-newest.
      sorted.sort(byReportedDesc);
      break;
  }
  return sorted;
}

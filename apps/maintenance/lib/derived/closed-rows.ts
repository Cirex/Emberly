import {
  compareNumbers,
  compareNumericStrings,
  compareStrings,
  type WorkOrderSortOption,
} from "./sort";
import { abbreviatedDate } from "./time";
import type { ParsedWorkOrder, UnitIndex } from "./types";

/**
 * Closed-board table rows — port of the SwiftUI closed list. Rows are flat
 * (no unit grouping) with display strings precomputed so the table renders
 * without touching parse/format logic.
 */

export interface ClosedWorkOrderRow {
  id: string;
  number: string;
  status: string;
  unitNumber: string;
  classification: string;
  title: string;
  dateCompletedText: string;
  dateCompletedMs: number | null;
  dateReportedMs: number | null;
  /** -1 when either date is missing — a sort key, never shown directly. */
  daysToComplete: number;
  /** "—" when missing, else the grouped number string. */
  daysToCompleteText: string;
  technicianDisplay: string;
}

export function buildClosedRows(input: {
  workOrders: ParsedWorkOrder[];
  option: WorkOrderSortOption;
  unitIndex: UnitIndex;
  nowMs: number;
}): ClosedWorkOrderRow[] {
  const { option, unitIndex, nowMs } = input;

  const rows: ClosedWorkOrderRow[] = input.workOrders.map((wo) => {
    const facts = unitIndex.get(wo.unitNumber);
    return {
      id: wo.id,
      number: wo.number,
      status: wo.status,
      unitNumber: wo.unitNumber,
      classification: facts?.classification.trim() ? facts.classification : "—",
      title: wo.title,
      dateCompletedText: abbreviatedDate(wo.completedAt, nowMs),
      dateCompletedMs: wo.completedAt,
      dateReportedMs: wo.reportedAt,
      daysToComplete: wo.daysToComplete ?? -1,
      daysToCompleteText: wo.daysToComplete === null ? "—" : wo.daysToComplete.toLocaleString(),
      technicianDisplay: wo.technicianDisplay,
    };
  });

  // Port of sortOrder(for:). recentMoveInDescending has no meaning on closed
  // rows, so Swift fell back to reported-newest; the port keeps that.
  switch (option) {
    case "dateReportedDescending":
    case "recentMoveInDescending":
      rows.sort((a, b) => compareNumbers(b.dateReportedMs ?? -Infinity, a.dateReportedMs ?? -Infinity));
      break;
    case "dateReportedAscending":
      rows.sort((a, b) => compareNumbers(a.dateReportedMs ?? Infinity, b.dateReportedMs ?? Infinity));
      break;
    case "idAscending":
      rows.sort((a, b) => compareNumericStrings(a.number, b.number));
      break;
    case "idDescending":
      rows.sort((a, b) => compareNumericStrings(b.number, a.number));
      break;
    case "statusAscending":
      rows.sort((a, b) => compareStrings(a.status, b.status));
      break;
    case "statusDescending":
      rows.sort((a, b) => compareStrings(b.status, a.status));
      break;
    case "unitAscending":
      rows.sort((a, b) => compareNumericStrings(a.unitNumber, b.unitNumber));
      break;
    case "dateCompletedDescending":
      rows.sort((a, b) => compareNumbers(b.dateCompletedMs ?? -Infinity, a.dateCompletedMs ?? -Infinity));
      break;
  }
  return rows;
}

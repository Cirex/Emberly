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
  /** Initials for the leading avatar. "" when unassigned. */
  technicianInitials: string;
  /**
   * The trade this work order is about, for the row's tag.
   *
   * Taken from the app's DERIVED tags, not from ResMan's `category`. The design
   * called for a category tag, but the live field is dominated by "Online Work
   * Order" — 818 of 2,885 closed rows — which names a submission channel, not a
   * trade, and would tag 28% of the board with nothing useful. The derived tags
   * are the curated trade vocabulary the rest of the app already tints.
   */
  tradeTag: string;
  /** "Same day" / "1 day" / "3 days" / "" when either date is missing. */
  daysToCloseLabel: string;
  /** A closure that later drew a callback signal — the quality counterweight. */
  isCallback: boolean;
}

/** Up to two initials. "Unassigned" and blanks yield "" — no empty circle. */
function initialsOf(display: string): string {
  const name = display.trim();
  if (name.length === 0 || /^unassigned$/i.test(name)) return "";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * How long it took, in the words the design uses. Zero is "Same day" rather
 * than "0 days" — the distinction a technician actually cares about.
 * Empty string when either date is missing, so the row simply omits the chip.
 */
function daysToCloseLabel(days: number | null): string {
  if (days === null || days < 0) return "";
  if (days === 0) return "Same day";
  return days === 1 ? "1 day" : `${days.toLocaleString()} days`;
}

/**
 * Rows reused across rebuilds, keyed on the RAW work order.
 *
 * A sync bumps dataVersion, every derived object is rebuilt, and every mounted
 * row re-renders because its `row` prop is a new object — measured at a 202ms
 * commit on device, and far worse on the pass that widens the staged parse. The
 * rows are pure functions of the raw row, so an unchanged one can keep its
 * object and its memoized component can skip.
 *
 * Raw identity already implies the title, number, unit, dates and technician are
 * unchanged, and tags are cached against the same object upstream. What it does
 * NOT imply is the cross-set engine signals or the unit's classification, so
 * those are checked explicitly — as is the calendar day, since the date label
 * is relative to it.
 */
interface CachedClosedRow {
  dayKey: number;
  classification: string;
  callbackStatus: string;
  row: ClosedWorkOrderRow;
}
const closedRowCache = new WeakMap<object, CachedClosedRow>();

export function buildClosedRows(input: {
  workOrders: ParsedWorkOrder[];
  option: WorkOrderSortOption;
  unitIndex: UnitIndex;
  nowMs: number;
}): ClosedWorkOrderRow[] {
  const { option, unitIndex, nowMs } = input;

  const dayKey = Math.floor(nowMs / 86_400_000);

  const rows: ClosedWorkOrderRow[] = input.workOrders.map((wo) => {
    const facts = unitIndex.get(wo.unitNumber);
    const classification = facts?.classification.trim() ? facts.classification : "—";
    const cached = closedRowCache.get(wo.raw);
    if (
      cached &&
      cached.dayKey === dayKey &&
      cached.classification === classification &&
      cached.callbackStatus === wo.callbackStatus
    ) {
      return cached.row;
    }
    const row: ClosedWorkOrderRow = {
      id: wo.id,
      number: wo.number,
      status: wo.status,
      unitNumber: wo.unitNumber,
      classification,
      title: wo.title,
      dateCompletedText: abbreviatedDate(wo.completedAt, nowMs),
      dateCompletedMs: wo.completedAt,
      dateReportedMs: wo.reportedAt,
      daysToComplete: wo.daysToComplete ?? -1,
      daysToCompleteText: wo.daysToComplete === null ? "—" : wo.daysToComplete.toLocaleString(),
      technicianDisplay: wo.technicianDisplay,
      technicianInitials: initialsOf(wo.technicianDisplay),
      tradeTag: wo.tags[0] ?? "",
      daysToCloseLabel: daysToCloseLabel(wo.daysToComplete),
      isCallback: wo.callbackStatus === "possible" || wo.callbackStatus === "confirmed",
    };
    closedRowCache.set(wo.raw, { dayKey, classification, callbackStatus: wo.callbackStatus, row });
    return row;
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
    case "statusAscending":
      rows.sort((a, b) => compareStrings(a.status, b.status));
      break;
    case "statusDescending":
      rows.sort((a, b) => compareStrings(b.status, a.status));
      break;
    case "unitAscending":
      rows.sort((a, b) => compareNumericStrings(a.unitNumber, b.unitNumber));
      break;
    case "unitDescending":
      rows.sort((a, b) => compareNumericStrings(b.unitNumber, a.unitNumber));
      break;
    case "dateCompletedAscending":
      // Oldest closed first — how you find the work that sat. Undated rows go
      // LAST here (+Infinity), the mirror of the descending case below.
      rows.sort((a, b) => compareNumbers(a.dateCompletedMs ?? Infinity, b.dateCompletedMs ?? Infinity));
      break;
    case "dateCompletedDescending":
      rows.sort((a, b) => compareNumbers(b.dateCompletedMs ?? -Infinity, a.dateCompletedMs ?? -Infinity));
      break;
  }
  return rows;
}

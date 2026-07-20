import type { ParsedWorkOrder, UnitIndex } from "./types";
import { monthInterval, monthStartBack, monthYearLabel, sameCalendarWeek } from "./time";

/**
 * Six-month open/closed volume by unit classification. Port of the Swift
 * monthly classification grid: work orders attributed to the month they were
 * REPORTED in, split by the unit's classification. Only the three tracked
 * classes (Ruby/Diamond/Legacy) count — Lux, blank, and unknown units are
 * excluded from per-class counts AND totals, matching Swift's keyed dictionary.
 */

const TRACKED_CLASSIFICATIONS = ["Ruby", "Diamond", "Legacy"] as const;
export type TrackedClassification = (typeof TRACKED_CLASSIFICATIONS)[number];

/** Mode membership, local by design (spec'd per module; do not import filters). */
const OPEN_STATUSES = ["Open", "In Progress", "Not Started", "On Hold", "Submitted", "Scheduled"];
const CLOSED_STATUSES = ["Closed", "Completed", "Cancelled", "Canceled"];

export interface MonthlyClassificationSummary {
  monthStartMs: number;
  monthLabel: string;
  openCounts: Record<TrackedClassification, number>;
  closedCounts: Record<TrackedClassification, number>;
  totalOpenCount: number;
  totalClosedCount: number;
  /** Reported-and-completed in one calendar week, tracked classes only. */
  sameWeekCompletedCount: number;
}

export interface MonthlyMetrics {
  totalOpen: number;
  totalClosed: number;
  /** Month with the most open+closed activity; FIRST (oldest) wins ties. */
  busiestMonthLabel: string | null;
}

function zeroCounts(): Record<TrackedClassification, number> {
  return { Ruby: 0, Diamond: 0, Legacy: 0 };
}

function isTracked(classification: string): classification is TrackedClassification {
  return (TRACKED_CLASSIFICATIONS as readonly string[]).includes(classification);
}

export function buildMonthlyClassification(input: {
  workOrders: ParsedWorkOrder[];
  unitIndex: UnitIndex;
  nowMs: number;
}): { months: MonthlyClassificationSummary[]; metrics: MonthlyMetrics } {
  const { workOrders, unitIndex, nowMs } = input;

  // Defensive: callers should pass the non-make-ready set already, but a turn
  // order must never inflate a classification's volume.
  const rows = workOrders.filter((wo) => !wo.isMakeReady);

  // Offsets 5..0 back from the current month, emitted oldest→newest.
  const months: MonthlyClassificationSummary[] = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const monthStart = monthStartBack(nowMs, offset);
    const { start, end } = monthInterval(monthStart);

    const summary: MonthlyClassificationSummary = {
      monthStartMs: start,
      monthLabel: monthYearLabel(start),
      openCounts: zeroCounts(),
      closedCounts: zeroCounts(),
      totalOpenCount: 0,
      totalClosedCount: 0,
      sameWeekCompletedCount: 0,
    };

    for (const wo of rows) {
      if (wo.reportedAt === null || wo.reportedAt < start || wo.reportedAt >= end) continue;
      const classification = unitIndex.get(wo.unitNumber)?.classification ?? "";
      if (!isTracked(classification)) continue;
      if (OPEN_STATUSES.includes(wo.status)) {
        summary.openCounts[classification] += 1;
        summary.totalOpenCount += 1;
      } else if (CLOSED_STATUSES.includes(wo.status)) {
        summary.closedCounts[classification] += 1;
        summary.totalClosedCount += 1;
      }
      // Same-week is independent of open/closed membership — any tracked order
      // attributed to the month counts when it closed in its reported week.
      if (wo.completedAt !== null && sameCalendarWeek(wo.reportedAt, wo.completedAt)) {
        summary.sameWeekCompletedCount += 1;
      }
    }

    months.push(summary);
  }

  let totalOpen = 0;
  let totalClosed = 0;
  let busiest: MonthlyClassificationSummary | null = null;
  let busiestVolume = 0;
  for (const month of months) {
    totalOpen += month.totalOpenCount;
    totalClosed += month.totalClosedCount;
    const volume = month.totalOpenCount + month.totalClosedCount;
    // Strict > keeps the FIRST (oldest) month on ties; zero months never win.
    if (volume > busiestVolume) {
      busiest = month;
      busiestVolume = volume;
    }
  }

  return {
    months,
    metrics: { totalOpen, totalClosed, busiestMonthLabel: busiest?.monthLabel ?? null },
  };
}

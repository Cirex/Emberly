import type { ParsedWorkOrder } from "./types";
import { addDays, calendarDaysBetween, monthDayRange, startOfWeek } from "./time";

/**
 * Technician completion grids. Port of the Swift weekly/monthly breakdown
 * panels: closed orders bucketed per technician into 7 day columns (current
 * Monday week) or 4 rolling-week columns (last 4 weeks ending this week).
 * "Unassigned" is a real row on purpose — unattributed completions should be
 * visible, not silently dropped.
 */

export interface TechnicianRow {
  technician: string;
  counts: number[];
  total: number;
  /** total / 7 (weekly, per day) or total / 4 (monthly, per week). */
  averagePerPeriod: number;
}

export interface TechnicianSummary {
  /** Weekly: ["Monday", …, "Sunday"]; monthly: 4 eyebrow date ranges. */
  columnLabels: string[];
  /** Sorted total desc, then name case-insensitive asc. */
  rows: TechnicianRow[];
  columnTotals: number[];
  columnMaxima: number[];
  totalCompleted: number;
  averagePerTechnician: number;
  /** Technicians tied at the max total; empty when nothing completed. */
  leaders: string[];
}

const WEEKDAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Panel chrome strings, kept beside the math so both grids stay in sync. */
export const BREAKDOWN_COPY = {
  week: {
    title: "Completed in Week",
    subtitle: "Technician breakdown for the current week",
    averageHeader: "Avg /Day",
    empty: "No technician completions recorded this week.",
  },
  month: {
    title: "Completed in Month",
    subtitle: "Rolling 4-week technician breakdown ending this week",
    averageHeader: "Avg /Week",
    empty: "No technician completions recorded in the last 4 weeks.",
  },
} as const;

/**
 * Shared assembly: bucket completions into columns per technician, then derive
 * rows/totals/leaders. `bucketOf` returns the column index or null to skip.
 */
function buildSummary(
  closedWorkOrders: ParsedWorkOrder[],
  columnLabels: string[],
  windowStart: number,
  windowEnd: number,
  averageDivisor: number,
  bucketOf: (completedAt: number) => number | null,
): TechnicianSummary {
  const columnCount = columnLabels.length;
  const countsByTechnician = new Map<string, number[]>();

  for (const wo of closedWorkOrders) {
    if (wo.completedAt === null) continue;
    if (wo.completedAt < windowStart || wo.completedAt >= windowEnd) continue;
    const bucket = bucketOf(wo.completedAt);
    if (bucket === null || bucket < 0 || bucket >= columnCount) continue;
    let counts = countsByTechnician.get(wo.technicianDisplay);
    if (!counts) {
      counts = new Array<number>(columnCount).fill(0);
      countsByTechnician.set(wo.technicianDisplay, counts);
    }
    counts[bucket] += 1;
  }

  const rows: TechnicianRow[] = [...countsByTechnician.entries()].map(([technician, counts]) => {
    const total = counts.reduce((sum, c) => sum + c, 0);
    return { technician, counts, total, averagePerPeriod: total / averageDivisor };
  });
  rows.sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total;
    return a.technician.toLowerCase().localeCompare(b.technician.toLowerCase());
  });

  const columnTotals = new Array<number>(columnCount).fill(0);
  const columnMaxima = new Array<number>(columnCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < columnCount; i += 1) {
      columnTotals[i] += row.counts[i];
      if (row.counts[i] > columnMaxima[i]) columnMaxima[i] = row.counts[i];
    }
  }

  const totalCompleted = rows.reduce((sum, r) => sum + r.total, 0);
  const maxTotal = rows.reduce((max, r) => Math.max(max, r.total), 0);
  return {
    columnLabels,
    rows,
    columnTotals,
    columnMaxima,
    totalCompleted,
    averagePerTechnician: rows.length > 0 ? totalCompleted / averageDivisor / rows.length : 0,
    leaders: maxTotal > 0 ? rows.filter((r) => r.total === maxTotal).map((r) => r.technician) : [],
  };
}

/** Current Monday-anchored week, one column per day. */
export function buildWeeklyTechnicianSummary(closedWorkOrders: ParsedWorkOrder[], nowMs: number): TechnicianSummary {
  const mondayStart = startOfWeek(nowMs);
  const nextWeek = addDays(mondayStart, 7);
  return buildSummary(closedWorkOrders, WEEKDAY_LABELS, mondayStart, nextWeek, 7, (completedAt) =>
    calendarDaysBetween(mondayStart, completedAt),
  );
}

/** Rolling 4 Monday weeks ending with the current week, one column per week. */
export function buildMonthlyTechnicianSummary(closedWorkOrders: ParsedWorkOrder[], nowMs: number): TechnicianSummary {
  const mondayStart = startOfWeek(nowMs);
  const nextWeek = addDays(mondayStart, 7);
  const weekStarts = [addDays(mondayStart, -21), addDays(mondayStart, -14), addDays(mondayStart, -7), mondayStart];
  const rollingStart = weekStarts[0];
  const labels = weekStarts.map((ws) => monthDayRange(ws, addDays(ws, 6)));
  return buildSummary(closedWorkOrders, labels, rollingStart, nextWeek, 4, (completedAt) => {
    const bucket = Math.floor(calendarDaysBetween(rollingStart, completedAt) / 7);
    return bucket < 0 || bucket > 3 ? null : bucket;
  });
}

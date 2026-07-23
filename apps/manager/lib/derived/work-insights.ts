import {
  calendarDaysBetween,
  isCallbackSignal,
  isClosedWorkOrder,
  isOpenWorkOrder,
  workOrderAgeDays,
  type ParsedWorkOrder,
} from "@emberly/core";
import type { WorkData } from "@/lib/derived/work-boards";

/**
 * Work · Insights (mockup frame 05) — the read-only statistics board over the
 * work-order mirror: scorecards, category mix, weekly close cadence, open-age
 * buckets, per-technician workload, and the hot-spots ranking. Pure so it's
 * testable; the screen renders whatever this returns.
 */

/** Target days-to-close the median is judged against ("target 4d" in the mock). */
export const CLOSE_TARGET_DAYS = 4;
/** An open order older than this reads as overdue. */
const OVERDUE_DAYS = CLOSE_TARGET_DAYS;
const WINDOW_90 = 90;
const CATEGORY_LIMIT = 6;
const TECH_LIMIT = 6;
const HOTSPOT_LIMIT = 5;
const CLOSES_WEEKS = 12;
const SIGNAL_WEEKS = 7;

export interface LabeledCount {
  label: string;
  count: number;
}
export interface TechWorkload {
  tech: string;
  openCount: number;
  medianCloseDays: number | null;
  closed30: number;
  unassigned: boolean;
}
export interface HotSpot {
  unitNumber: string;
  orders: number;
  callbacks: number;
  /** 1 = highest risk. */
  rank: number;
}
export interface WorkInsights {
  openNow: number;
  overdue: number;
  emergencies: number;
  closed30: number;
  closedPrior30: number;
  medianCloseDays: number | null;
  targetDays: number;
  callbackRatePct: number;
  callbackPairs: number;
  perTech: number;
  categories: LabeledCount[];
  /** 12 weeks of closes, oldest → newest. */
  closesPerWeek: number[];
  /** 0–1 / 2–3 / 4–7 / 8+ days, in that order. */
  ageBuckets: LabeledCount[];
  techWorkload: TechWorkload[];
  hotSpots: HotSpot[];
  /** Recent weeks of total order signals, oldest → newest (hot-spots sparkline). */
  signalsPerWeek: number[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Whole weeks between `ms` and now (0 = this week). */
function weeksAgo(ms: number, nowMs: number): number {
  return Math.floor(calendarDaysBetween(ms, nowMs) / 7);
}

function isEmergency(wo: ParsedWorkOrder): boolean {
  return wo.priority.toLowerCase() === "emergency";
}

function categoryLabel(wo: ParsedWorkOrder): string {
  return wo.raw.category?.trim() || "Other";
}

export function buildWorkInsights(data: WorkData, nowMs: number): WorkInsights {
  const parsed = data.parsed;
  const open = parsed.filter(isOpenWorkOrder);
  const closed = parsed.filter(isClosedWorkOrder);
  const closed90 = closed.filter(
    (wo) => wo.completedAt !== null && calendarDaysBetween(wo.completedAt, nowMs) <= WINDOW_90,
  );

  // ── Scorecards ─────────────────────────────────────────────────────────
  const openNow = open.length;
  const overdue = open.filter((wo) => workOrderAgeDays(wo, nowMs) > OVERDUE_DAYS).length;
  const emergencies = open.filter(isEmergency).length;

  const closed30 = closed.filter(
    (wo) => wo.completedAt !== null && calendarDaysBetween(wo.completedAt, nowMs) <= 30,
  ).length;
  const closedPrior30 = closed.filter((wo) => {
    if (wo.completedAt === null) return false;
    const d = calendarDaysBetween(wo.completedAt, nowMs);
    return d > 30 && d <= 60;
  }).length;

  const medianCloseDays = median(
    closed90.map((wo) => wo.daysToComplete).filter((d): d is number => d !== null),
  );

  const callbacks90 = closed90.filter(isCallbackSignal).length;
  const callbackRatePct = closed90.length === 0 ? 0 : (callbacks90 / closed90.length) * 100;

  const activeTechs = new Set(
    open.filter((wo) => wo.technicianDisplay !== "Unassigned").map((wo) => wo.technicianDisplay),
  ).size;
  const perTech = activeTechs === 0 ? openNow : openNow / activeTechs;

  // ── Category mix (open + 90-day closed) ────────────────────────────────
  const catCounts = new Map<string, number>();
  for (const wo of [...open, ...closed90]) {
    const label = categoryLabel(wo);
    catCounts.set(label, (catCounts.get(label) ?? 0) + 1);
  }
  const categories = [...catCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, CATEGORY_LIMIT);

  // ── Closes per week (12 weeks, oldest → newest) ────────────────────────
  const closesPerWeek = Array.from({ length: CLOSES_WEEKS }, () => 0);
  for (const wo of closed) {
    if (wo.completedAt === null) continue;
    const w = weeksAgo(wo.completedAt, nowMs);
    if (w >= 0 && w < CLOSES_WEEKS) closesPerWeek[CLOSES_WEEKS - 1 - w] += 1;
  }

  // ── Open-age buckets ────────────────────────────────────────────────────
  const buckets = { "0-1": 0, "2-3": 0, "4-7": 0, "8+": 0 };
  for (const wo of open) {
    const age = workOrderAgeDays(wo, nowMs);
    if (age <= 1) buckets["0-1"] += 1;
    else if (age <= 3) buckets["2-3"] += 1;
    else if (age <= 7) buckets["4-7"] += 1;
    else buckets["8+"] += 1;
  }
  const ageBuckets: LabeledCount[] = [
    { label: "0–1 day", count: buckets["0-1"] },
    { label: "2–3 days", count: buckets["2-3"] },
    { label: "4–7 days", count: buckets["4-7"] },
    { label: "8+ days", count: buckets["8+"] },
  ];

  // ── Technician workload ─────────────────────────────────────────────────
  const techNames = new Set(parsed.map((wo) => wo.technicianDisplay));
  const techWorkload: TechWorkload[] = [...techNames]
    .map((tech) => {
      const openCount = open.filter((wo) => wo.technicianDisplay === tech).length;
      const theirClosed90 = closed90.filter((wo) => wo.technicianDisplay === tech);
      return {
        tech,
        openCount,
        medianCloseDays: median(
          theirClosed90.map((wo) => wo.daysToComplete).filter((d): d is number => d !== null),
        ),
        closed30: closed.filter(
          (wo) =>
            wo.technicianDisplay === tech &&
            wo.completedAt !== null &&
            calendarDaysBetween(wo.completedAt, nowMs) <= 30,
        ).length,
        unassigned: tech === "Unassigned",
      };
    })
    .filter((t) => t.openCount > 0 || t.closed30 > 0)
    .sort((a, b) => b.openCount - a.openCount || b.closed30 - a.closed30)
    .slice(0, TECH_LIMIT);

  // ── Hot spots — risk blends order density, callbacks, and recency ───────
  const byUnit = new Map<string, ParsedWorkOrder[]>();
  for (const wo of parsed) {
    if (wo.unitNumber === "") continue;
    const arr = byUnit.get(wo.unitNumber);
    if (arr) arr.push(wo);
    else byUnit.set(wo.unitNumber, [wo]);
  }
  const hotSpots: HotSpot[] = [...byUnit.entries()]
    .map(([unitNumber, orders]) => {
      const callbacks = orders.filter(isCallbackSignal).length;
      const recent = orders.filter(
        (wo) => wo.reportedAt !== null && calendarDaysBetween(wo.reportedAt, nowMs) <= 21,
      ).length;
      const score = orders.length + callbacks * 2 + recent;
      return { unitNumber, orders: orders.length, callbacks, score };
    })
    .filter((h) => h.orders >= 2)
    .sort((a, b) => b.score - a.score || b.orders - a.orders)
    .slice(0, HOTSPOT_LIMIT)
    .map((h, i) => ({ unitNumber: h.unitNumber, orders: h.orders, callbacks: h.callbacks, rank: i + 1 }));

  // ── Signals per week (recent weeks, oldest → newest) ────────────────────
  const signalsPerWeek = Array.from({ length: SIGNAL_WEEKS }, () => 0);
  for (const wo of parsed) {
    if (wo.reportedAt === null) continue;
    const w = weeksAgo(wo.reportedAt, nowMs);
    if (w >= 0 && w < SIGNAL_WEEKS) signalsPerWeek[SIGNAL_WEEKS - 1 - w] += 1;
  }

  return {
    openNow,
    overdue,
    emergencies,
    closed30,
    closedPrior30,
    medianCloseDays,
    targetDays: CLOSE_TARGET_DAYS,
    callbackRatePct,
    callbackPairs: callbacks90,
    perTech,
    categories,
    closesPerWeek,
    ageBuckets,
    techWorkload,
    hotSpots,
    signalsPerWeek,
  };
}

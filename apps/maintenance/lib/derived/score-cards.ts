import type { DisplayMode, ParsedWorkOrder } from "./types";
import type { MakeReadyGroup } from "./make-ready";
import type { HotSpotRow } from "./hot-spots";
import type { TechnicianSummary } from "./technician-summary";
import { earliestReportedDate, isFullyCompletedTurn, latestCompletedDate } from "./make-ready";
import { TINT } from "./status";
import { DAY_MS, addDays, calendarDaysBetween, sameCalendarMonth, sameCalendarWeek, startOfDay, startOfWeek } from "./time";

/**
 * Score-card strip — port of the Swift dashboard's four headline tiles per
 * display mode. Every string the UI shows is composed HERE (values, captions,
 * icon names, tints) so the component stays a dumb renderer and the copy is
 * testable. All four modes always return exactly four cards.
 */

export interface ScoreCard {
  key: string;
  title: string;
  value: string;
  caption: string;
  /** Ionicons name. */
  icon: string;
  /** Hex tint. */
  tint: string;
  interactive: boolean;
  action: "openMonthly" | "sameWeek" | "daysToClose" | "callbacks" | "technicianWeek" | "technicianMonth" | null;
}

/** Callback signal, local by design (spec'd per module; do not import filters). */
const CALLBACK_SIGNALS = new Set(["possible", "confirmed"]);

/** The Swift olive accent the tiles used; not in the security token palette. */
const OLIVE = "#A2A921";

function count(n: number): string {
  return n.toLocaleString();
}

/** "1 day" / "<n> days" for whole-day counts. */
function dayCountText(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** One-decimal day averages; near-1 averages read as the clean "1 day". */
function averageDayText(avg: number): string {
  return Math.abs(avg - 1) < 0.05 ? "1 day" : `${avg.toFixed(1)} days`;
}

function averageCompletionText(completedCount: number, technicianCount: number, period: "week" | "month"): string {
  if (technicianCount === 0) return `No technician completions this ${period}`;
  return `Avg ${(completedCount / technicianCount).toFixed(1)} per technician`;
}

export function buildScoreCards(input: {
  mode: DisplayMode;
  /** The mode-filtered visible list (post search/filters). */
  visible: ParsedWorkOrder[];
  openFiltered: ParsedWorkOrder[];
  closedFiltered: ParsedWorkOrder[];
  /** For submitted-in-month, which ignores the open/closed split. */
  allNonMakeReady: ParsedWorkOrder[];
  makeReadyGroups: MakeReadyGroup[];
  hotSpotRows: HotSpotRow[];
  weeklySummary: TechnicianSummary;
  nowMs: number;
}): ScoreCard[] {
  switch (input.mode) {
    case "open":
      return openCards(input.visible, input.openFiltered, input.allNonMakeReady, input.nowMs);
    case "closed":
      return closedCards(input.closedFiltered, input.weeklySummary, input.nowMs);
    case "makeReady":
      return makeReadyCards(input.makeReadyGroups, input.nowMs);
    case "hotSpots":
      return hotSpotCards(input.hotSpotRows);
  }
}

// ── Open mode ───────────────────────────────────────────────────────────────

function openCards(
  visible: ParsedWorkOrder[],
  openFiltered: ParsedWorkOrder[],
  allNonMakeReady: ParsedWorkOrder[],
  nowMs: number,
): ScoreCard[] {
  const uniqueUnitCount = new Set(visible.map((wo) => wo.unitNumber)).size;

  const submitted = allNonMakeReady.filter((wo) => wo.reportedAt !== null && sameCalendarMonth(wo.reportedAt, nowMs));
  const submittedCompleted = submitted.filter((wo) => wo.completedAt !== null).length;
  const submittedRate = submitted.length > 0 ? submittedCompleted / submitted.length : 0;

  // Aging: days each dated open order has sat, measured to today's midnight.
  const today = startOfDay(nowMs);
  const openAges = openFiltered
    .filter((wo) => wo.reportedAt !== null)
    .map((wo) => Math.max(calendarDaysBetween(wo.reportedAt as number, today), 0));
  const agingCount = openAges.filter((days) => days >= 8).length;
  const oldest = openAges.reduce((max, days) => Math.max(max, days), 0);
  const averageAge = openAges.length > 0 ? openAges.reduce((sum, d) => sum + d, 0) / openAges.length : 0;

  const callbackCount = openFiltered.filter((wo) => CALLBACK_SIGNALS.has(wo.callbackStatus)).length;

  return [
    {
      key: "open-total",
      title: "Open Work Orders",
      value: count(visible.length),
      caption: `${uniqueUnitCount} units with open work`,
      icon: "list-outline",
      tint: OLIVE,
      interactive: true,
      action: "openMonthly",
    },
    {
      key: "open-submitted-month",
      title: "Submitted in Month",
      value: count(submitted.length),
      caption: `${(submittedRate * 100).toFixed(2)}% completed`,
      icon: "download-outline",
      tint: TINT.accentBlue,
      interactive: false,
      action: null,
    },
    {
      key: "open-aging-risk",
      title: "Aging Risk",
      value: count(agingCount),
      caption:
        openAges.length === 0
          ? "No dated open work orders"
          : `Oldest ${dayCountText(oldest)}, avg ${averageDayText(averageAge)} open`,
      icon: "time-outline",
      tint: TINT.blocked,
      interactive: false,
      action: null,
    },
    {
      key: "open-callbacks",
      title: "Callbacks",
      value: count(callbackCount),
      caption:
        callbackCount === 0
          ? "No callback candidates in view"
          : callbackCount === 1
            ? "1 open ticket matches completed work"
            : `${callbackCount} open tickets match completed work`,
      icon: "arrow-undo-circle-outline",
      tint: TINT.review,
      interactive: true,
      action: "callbacks",
    },
  ];
}

// ── Closed mode ─────────────────────────────────────────────────────────────

function closedCards(closedFiltered: ParsedWorkOrder[], weeklySummary: TechnicianSummary, nowMs: number): ScoreCard[] {
  // Same-week rate over the 90-day window, current (incomplete) week excluded.
  const windowStart = nowMs - 90 * DAY_MS;
  const currentWeekStart = startOfWeek(nowMs);
  let sample = 0;
  let sameWeek = 0;
  for (const wo of closedFiltered) {
    if (wo.completedAt === null || wo.completedAt < windowStart || wo.completedAt >= currentWeekStart) continue;
    sample += 1;
    if (wo.reportedAt !== null && sameCalendarWeek(wo.reportedAt, wo.completedAt)) sameWeek += 1;
  }
  const sameWeekRate = sample > 0 ? sameWeek / sample : 0;

  const closeDays = closedFiltered
    .filter((wo) => wo.reportedAt !== null && wo.completedAt !== null && wo.daysToComplete !== null)
    .map((wo) => wo.daysToComplete as number);
  const averageDays = closeDays.length > 0 ? closeDays.reduce((sum, d) => sum + d, 0) / closeDays.length : 0;

  const nextWeekStart = addDays(currentWeekStart, 7);
  const closedThisWeek = closedFiltered.filter(
    (wo) => wo.completedAt !== null && wo.completedAt >= currentWeekStart && wo.completedAt < nextWeekStart,
  ).length;

  const closedThisMonth = closedFiltered.filter(
    (wo) => wo.completedAt !== null && sameCalendarMonth(wo.completedAt, nowMs),
  );
  const monthTechnicians = new Set(
    closedThisMonth.map((wo) => wo.technicianDisplay).filter((tech) => tech !== "Unassigned"),
  ).size;

  return [
    {
      key: "closed-same-week",
      title: "Closed Same Week",
      value: count(sameWeek),
      caption:
        sample === 0
          ? "No closed work orders in the last 90 days"
          : `${(sameWeekRate * 100).toFixed(1)}% of ${sample} tickets in 90 days`,
      icon: "checkmark-circle-outline",
      tint: OLIVE,
      interactive: true,
      action: "sameWeek",
    },
    {
      key: "closed-avg-days",
      title: "Avg Days to Close",
      value: averageDays.toFixed(1),
      caption: closeDays.length === 0 ? "No closed work orders in view" : `Across ${closeDays.length} closed work orders`,
      icon: "time-outline",
      tint: TINT.accentBlue,
      interactive: true,
      action: "daysToClose",
    },
    {
      key: "closed-this-week",
      title: "Closed This Week",
      value: count(closedThisWeek),
      caption: averageCompletionText(closedThisWeek, weeklySummary.rows.length, "week"),
      icon: "calendar-outline",
      tint: TINT.ready,
      interactive: true,
      action: "technicianWeek",
    },
    {
      key: "closed-this-month",
      title: "Closed This Month",
      value: count(closedThisMonth.length),
      caption: averageCompletionText(closedThisMonth.length, monthTechnicians, "month"),
      icon: "calendar-outline",
      tint: TINT.warning,
      interactive: true,
      action: "technicianMonth",
    },
  ];
}

// ── Make-ready mode ─────────────────────────────────────────────────────────

function makeReadyCards(groups: MakeReadyGroup[], nowMs: number): ScoreCard[] {
  const inProgress = groups.filter((g) => g.unitStatus !== "Ready").length;

  const fullyCompleted = groups.filter(isFullyCompletedTurn);
  const completedThisMonth = fullyCompleted.filter((g) => {
    const finished = latestCompletedDate(g);
    return finished !== null && sameCalendarMonth(finished, nowMs);
  }).length;
  const startedThisMonth = groups.filter((g) => {
    const started = earliestReportedDate(g);
    return started !== null && sameCalendarMonth(started, nowMs);
  }).length;

  // Turn duration over the trailing 90 days of finished turns.
  const windowStart = nowMs - 90 * DAY_MS;
  const turnDays: number[] = [];
  for (const g of fullyCompleted) {
    const finished = latestCompletedDate(g);
    if (finished === null || finished < windowStart) continue;
    const started = earliestReportedDate(g);
    if (started === null) continue;
    turnDays.push(Math.max(calendarDaysBetween(started, finished), 0));
  }
  const averageTurnDays = turnDays.length > 0 ? turnDays.reduce((sum, d) => sum + d, 0) / turnDays.length : 0;

  const today = startOfDay(nowMs);
  const overdue = groups.filter((g) => g.moveInAt !== null && startOfDay(g.moveInAt) < today).length;

  return [
    {
      key: "make-ready-in-progress",
      title: "Turns in Progress",
      value: count(inProgress),
      caption: "Units not yet ready",
      icon: "hammer-outline",
      tint: OLIVE,
      interactive: false,
      action: null,
    },
    {
      key: "make-ready-completed-month",
      title: "Completed This Month",
      value: count(completedThisMonth),
      caption:
        startedThisMonth === 1 ? "1 turn started this month" : `${startedThisMonth} turns started this month`,
      icon: "checkmark-circle-outline",
      tint: TINT.ready,
      interactive: false,
      action: null,
    },
    {
      key: "make-ready-avg-days",
      title: "Avg Days in Turn",
      value: averageTurnDays.toFixed(1),
      caption:
        turnDays.length === 0 ? "No completed turns in the last 3 months" : `Across ${turnDays.length} turns in 90 days`,
      icon: "time-outline",
      tint: TINT.accentBlue,
      interactive: false,
      action: null,
    },
    {
      key: "make-ready-overdue",
      title: "Overdue Turns",
      value: count(overdue),
      caption:
        overdue === 0
          ? "No turns past move-in date"
          : overdue === 1
            ? "1 turn past move-in date"
            : `${overdue} turns past move-in date`,
      icon: "warning-outline",
      tint: TINT.blocked,
      interactive: false,
      action: null,
    },
  ];
}

// ── Hot-spots mode ──────────────────────────────────────────────────────────

function hotSpotCards(rows: HotSpotRow[]): ScoreCard[] {
  const highRisk = rows.filter((r) => r.riskLevel === "High").length;
  const openTotal = rows.reduce((sum, r) => sum + r.openCount, 0);
  const callbackTotal = rows.reduce((sum, r) => sum + r.callbackCount, 0);
  const recentTotal = rows.reduce((sum, r) => sum + r.recentCount, 0);

  return [
    {
      key: "hot-spots-units",
      title: "Hot Spot Units",
      value: count(rows.length),
      caption: "Units with repeat maintenance signals",
      icon: "flame-outline",
      tint: OLIVE,
      interactive: false,
      action: null,
    },
    {
      key: "hot-spots-high-risk",
      title: "High Risk Units",
      value: count(highRisk),
      caption:
        highRisk === 0 ? "No high-risk hot spots" : highRisk === 1 ? "1 unit needs review" : `${highRisk} units need review`,
      icon: "warning-outline",
      tint: TINT.blocked,
      interactive: false,
      action: null,
    },
    {
      key: "hot-spots-open",
      title: "Open on Hot Spots",
      value: count(openTotal),
      caption: openTotal === 0 ? "No open work on hot spots" : "Open tickets tied to hot spot units",
      icon: "folder-open-outline",
      tint: TINT.warning,
      interactive: false,
      action: null,
    },
    {
      key: "hot-spots-callbacks",
      title: "Callback Signals",
      value: count(callbackTotal),
      caption: `${recentTotal} recent tickets in 90 days`,
      icon: "arrow-undo-circle-outline",
      tint: TINT.review,
      interactive: false,
      action: null,
    },
  ];
}

import type { DisplayMode, ParsedWorkOrder } from "./types";
import type { MakeReadyGroup } from "./make-ready";
import type { HotSpotRow } from "./hot-spots";
import type { TechnicianSummary } from "./technician-summary";
import { earliestReportedDate, isFullyCompletedTurn, latestCompletedDate } from "./make-ready";
import { TINT } from "./status";
import { DAY_MS, addDays, calendarDaysBetween, sameCalendarMonth, sameCalendarWeek, startOfDay, startOfWeek } from "./time";
import i18n from "@/lib/i18n";

const t = i18n.t.bind(i18n);

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
  return t("scoreCards.captions.day", { count: n });
}

/** One-decimal day averages; near-1 averages read as the clean "1 day". */
function averageDayText(avg: number): string {
  return Math.abs(avg - 1) < 0.05 ? t("scoreCards.captions.day", { count: 1 }) : t("scoreCards.captions.daysDecimal", { value: avg.toFixed(1) });
}

function averageCompletionText(completedCount: number, technicianCount: number, period: "week" | "month"): string {
  if (technicianCount === 0) return period === "week" ? t("scoreCards.captions.noTechWeek") : t("scoreCards.captions.noTechMonth");
  return t("scoreCards.captions.avgPerTech", { value: (completedCount / technicianCount).toFixed(1) });
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
      title: t("scoreCards.openTotal"),
      value: count(visible.length),
      caption: t("scoreCards.captions.unitsWithOpenWork", { count: uniqueUnitCount }),
      icon: "list-outline",
      tint: OLIVE,
      interactive: true,
      action: "openMonthly",
    },
    {
      key: "open-submitted-month",
      title: t("scoreCards.submittedMonth"),
      value: count(submitted.length),
      caption: t("scoreCards.captions.pctCompleted", { pct: (submittedRate * 100).toFixed(2) }),
      icon: "download-outline",
      tint: TINT.accentBlue,
      interactive: false,
      action: null,
    },
    {
      key: "open-aging-risk",
      title: t("scoreCards.agingRisk"),
      value: count(agingCount),
      caption:
        openAges.length === 0
          ? t("scoreCards.captions.noDatedOpen")
          : t("scoreCards.captions.agingDetail", { oldest: dayCountText(oldest), avg: averageDayText(averageAge) }),
      icon: "time-outline",
      tint: TINT.blocked,
      interactive: false,
      action: null,
    },
    {
      key: "open-callbacks",
      title: t("scoreCards.callbacks"),
      value: count(callbackCount),
      caption:
        callbackCount === 0
          ? t("scoreCards.captions.noCallbacks")
          : t("scoreCards.captions.callbackMatches", { count: callbackCount }),
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
      title: t("scoreCards.closedSameWeek"),
      value: count(sameWeek),
      caption:
        sample === 0
          ? t("scoreCards.captions.noClosed90")
          : t("scoreCards.captions.sameWeekDetail", { pct: (sameWeekRate * 100).toFixed(1), sample }),
      icon: "checkmark-circle-outline",
      tint: OLIVE,
      interactive: true,
      action: "sameWeek",
    },
    {
      key: "closed-avg-days",
      title: t("scoreCards.avgDaysToClose"),
      value: averageDays.toFixed(1),
      caption: closeDays.length === 0 ? t("scoreCards.captions.noClosedInView") : t("scoreCards.captions.acrossClosed", { count: closeDays.length }),
      icon: "time-outline",
      tint: TINT.accentBlue,
      interactive: true,
      action: "daysToClose",
    },
    {
      key: "closed-this-week",
      title: t("scoreCards.closedThisWeek"),
      value: count(closedThisWeek),
      caption: averageCompletionText(closedThisWeek, weeklySummary.rows.length, "week"),
      icon: "calendar-outline",
      tint: TINT.ready,
      interactive: true,
      action: "technicianWeek",
    },
    {
      key: "closed-this-month",
      title: t("scoreCards.closedThisMonth"),
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
      title: t("scoreCards.turnsInProgress"),
      value: count(inProgress),
      caption: t("scoreCards.captions.unitsNotReady"),
      icon: "hammer-outline",
      tint: OLIVE,
      interactive: false,
      action: null,
    },
    {
      key: "make-ready-completed-month",
      title: t("scoreCards.completedThisMonth"),
      value: count(completedThisMonth),
      caption: t("scoreCards.captions.turnsStarted", { count: startedThisMonth }),
      icon: "checkmark-circle-outline",
      tint: TINT.ready,
      interactive: false,
      action: null,
    },
    {
      key: "make-ready-avg-days",
      title: t("scoreCards.avgDaysInTurn"),
      value: averageTurnDays.toFixed(1),
      caption: turnDays.length === 0 ? t("scoreCards.captions.noTurns90") : t("scoreCards.captions.acrossTurns90", { count: turnDays.length }),
      icon: "time-outline",
      tint: TINT.accentBlue,
      interactive: false,
      action: null,
    },
    {
      key: "make-ready-overdue",
      title: t("scoreCards.overdueTurns"),
      value: count(overdue),
      caption: overdue === 0 ? t("scoreCards.captions.noOverdueTurns") : t("scoreCards.captions.overdueTurns", { count: overdue }),
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
      title: t("scoreCards.hotSpotUnits"),
      value: count(rows.length),
      caption: t("scoreCards.captions.repeatSignals"),
      icon: "flame-outline",
      tint: OLIVE,
      interactive: false,
      action: null,
    },
    {
      key: "hot-spots-high-risk",
      title: t("scoreCards.highRiskUnits"),
      value: count(highRisk),
      caption: highRisk === 0 ? t("scoreCards.captions.noHighRisk") : t("scoreCards.captions.needsReview", { count: highRisk }),
      icon: "warning-outline",
      tint: TINT.blocked,
      interactive: false,
      action: null,
    },
    {
      key: "hot-spots-open",
      title: t("scoreCards.openOnHotSpots"),
      value: count(openTotal),
      caption: openTotal === 0 ? t("scoreCards.captions.noOpenHotSpots") : t("scoreCards.captions.openOnHotSpots"),
      icon: "folder-open-outline",
      tint: TINT.warning,
      interactive: false,
      action: null,
    },
    {
      key: "hot-spots-callbacks",
      title: t("scoreCards.callbackSignals"),
      value: count(callbackTotal),
      caption: t("scoreCards.captions.recentTickets90", { count: recentTotal }),
      icon: "arrow-undo-circle-outline",
      tint: TINT.review,
      interactive: false,
      action: null,
    },
  ];
}

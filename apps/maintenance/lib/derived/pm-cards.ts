import type { PmTemplateRound } from "@/lib/api/pm-tasks";
import i18n from "@/lib/i18n";
import type { ScoreCard } from "./score-cards";
import { TINT } from "./status";
import { calendarDaysBetween, startOfDay } from "./time";

const t = i18n.t.bind(i18n);

/**
 * Preventive-mode aggregation. The PM round lives outside the work-order
 * derived engine (pm_tasks are not work orders), so the Preventive board's
 * score cards are composed here from the PM store's template groups instead of
 * inside buildScoreCards. Same contract as score-cards.ts: every string the UI
 * shows is composed HERE so the components stay dumb renderers.
 */

/** Local midnight of a date-only "YYYY-MM-DD" string, or null when unset.
 *  Parsed locally on purpose — Date.parse would read it as UTC midnight and
 *  shift the due day in negative-offset timezones (see derived/types.ts). */
export function pmDueDateMs(dueDate: string | null): number | null {
  if (!dueDate) return null;
  const [y, m, d] = dueDate.split("-").map((part) => Number.parseInt(part, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

/** Whole days a round is past its due date (0 = due today or not yet due). */
export function pmDaysLate(dueDate: string | null, nowMs: number): number {
  const dueMs = pmDueDateMs(dueDate);
  if (dueMs === null) return 0;
  return Math.max(calendarDaysBetween(dueMs, startOfDay(nowMs)), 0);
}

/** True when the round still has pending units past its due date. */
export function pmRoundOverdue(template: PmTemplateRound, nowMs: number): boolean {
  return (
    pmDaysLate(template.dueDate, nowMs) > 0 &&
    template.tasks.some((task) => task.status === "pending")
  );
}

export interface PmRoundTotals {
  total: number;
  pending: number;
  done: number;
  skipped: number;
  /** Pending tasks past their round's due date. */
  overdue: number;
  /** Templates that actually have generated tasks this round. */
  rounds: number;
  /** Days late of the most overdue round (0 = nothing late). */
  oldestLateDays: number;
}

export function pmRoundTotals(templates: readonly PmTemplateRound[], nowMs: number): PmRoundTotals {
  const totals: PmRoundTotals = {
    total: 0,
    pending: 0,
    done: 0,
    skipped: 0,
    overdue: 0,
    rounds: 0,
    oldestLateDays: 0,
  };
  for (const template of templates) {
    if (template.tasks.length > 0) totals.rounds += 1;
    const late = pmDaysLate(template.dueDate, nowMs) > 0;
    for (const task of template.tasks) {
      totals.total += 1;
      if (task.status === "done") totals.done += 1;
      else if (task.status === "skipped") totals.skipped += 1;
      else {
        totals.pending += 1;
        if (late) totals.overdue += 1;
      }
    }
    if (late && template.tasks.some((task) => task.status === "pending")) {
      totals.oldestLateDays = Math.max(totals.oldestLateDays, pmDaysLate(template.dueDate, nowMs));
    }
  }
  return totals;
}

/**
 * The Preventive mode's four cards — card[0] backs the pill, cards 1..3 render
 * as the header strip: due this round, done, overdue (pending past due date).
 */
export function buildPreventiveScoreCards(
  templates: readonly PmTemplateRound[],
  nowMs: number,
): ScoreCard[] {
  const totals = pmRoundTotals(templates, nowMs);
  const donePct = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

  return [
    {
      key: "pm-total",
      title: t("preventive.scoreCards.total"),
      value: totals.total.toLocaleString(),
      caption: t("preventive.captions.acrossTemplates", { count: templates.length }),
      icon: "sync-outline",
      tint: null,
      interactive: false,
      action: null,
    },
    {
      key: "pm-due-round",
      title: t("preventive.scoreCards.dueThisRound"),
      value: totals.pending.toLocaleString(),
      caption: t("preventive.captions.acrossRounds", { count: totals.rounds }),
      icon: "calendar-outline",
      tint: TINT.warning,
      interactive: false,
      action: null,
    },
    {
      key: "pm-done",
      title: t("preventive.scoreCards.done"),
      value: totals.done.toLocaleString(),
      caption:
        totals.total === 0
          ? t("preventive.captions.noTasks")
          : t("preventive.captions.pctOfRound", { pct: donePct }),
      icon: "checkmark-circle-outline",
      tint: TINT.ready,
      interactive: false,
      action: null,
    },
    {
      key: "pm-overdue",
      title: t("preventive.scoreCards.overdue"),
      value: totals.overdue.toLocaleString(),
      caption:
        totals.overdue === 0
          ? t("preventive.captions.nonePastDue")
          : t("preventive.captions.oldestLate", { count: totals.oldestLateDays }),
      icon: "warning-outline",
      tint: TINT.blocked,
      interactive: false,
      action: null,
    },
  ];
}

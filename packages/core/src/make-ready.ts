/**
 * Make-ready board derivations. Port of MakeReadyStage/BoardGroup/Urgency/
 * QuickFilter (Swift): each vacant-turn unit gets a six-stage checklist, the
 * stages are claimed from work-order TITLES (category is deliberately not
 * consulted — ResMan categories were too noisy in practice), and urgency is a
 * pure function of the move-in date bracket.
 *
 * Promoted from apps/maintenance/lib/derived/make-ready.ts — the manager app's
 * Work tab and Today card read the same turn board, so the engine lives here
 * and both apps import it.
 */

import { calendarDaysBetween } from "./calendar";
import type { ParsedWorkOrder, UnitIndex } from "./work-orders";

// ── Stages ──────────────────────────────────────────────────────────────────

export const MAKE_READY_STAGES = [
  "trashOut",
  "punch",
  "flooring",
  "finalInspection",
  "cleaning",
  "rekey",
] as const;
export type MakeReadyStage = (typeof MAKE_READY_STAGES)[number];

/**
 * ALL stages the (lowercased) title matches — a single order can claim more
 * than one slot ("Final Inspection & Cleaning"). Substring rules ported
 * verbatim; "touch up painting" counts as cleaning because that's how the
 * property actually files the touch-up pass.
 */
export function stagesOf(title: string): MakeReadyStage[] {
  const t = title.toLowerCase();
  const stages: MakeReadyStage[] = [];
  if (t.includes("trash out")) stages.push("trashOut");
  if (t.includes("punch")) stages.push("punch");
  if (t.includes("flooring")) stages.push("flooring");
  if (t.includes("final unit walk/inspection") || (t.includes("final") && t.includes("inspection"))) {
    stages.push("finalInspection");
  }
  if (t.includes("touch up painting") || t.includes("touch up paint") || t.includes("cleaning")) {
    stages.push("cleaning");
  }
  if (t.includes("rekey")) stages.push("rekey");
  return stages;
}

// ── Urgency ─────────────────────────────────────────────────────────────────

export type MoveInUrgency =
  | "missingDate"
  | "overdue"
  | "today"
  | "nextSevenDays"
  | "nextFourteenDays"
  | "scheduled";

/** Bracket the move-in date: signed calendar days from today. */
export function moveInUrgency(moveInAt: number | null, nowMs: number): MoveInUrgency {
  if (moveInAt === null) return "missingDate";
  const dayCount = calendarDaysBetween(nowMs, moveInAt);
  if (dayCount < 0) return "overdue";
  if (dayCount === 0) return "today";
  if (dayCount <= 7) return "nextSevenDays";
  if (dayCount <= 14) return "nextFourteenDays";
  return "scheduled";
}

/** Only the urgent-now brackets get a badge in the UI. */
export function urgencyShowsBadge(u: MoveInUrgency): boolean {
  return u === "overdue" || u === "today" || u === "nextSevenDays";
}

// ── Board groups ────────────────────────────────────────────────────────────

const COMPLETED_STATUSES = new Set(["Completed", "Closed"]);

function isCompleted(wo: ParsedWorkOrder): boolean {
  return COMPLETED_STATUSES.has(wo.status);
}

export interface MakeReadyGroup {
  unitNumber: string;
  moveInAt: number | null;
  /** facts.availability ?? "—" — the make-ready board's unit status column. */
  unitStatus: string;
  classification: string;
  /** Most recent reportedAt in the group (the "latest activity" column). */
  latestDateMs: number | null;
  /** Every make-ready order in the group, reportedAt desc (score cards need
   *  the full list for earliest-reported). */
  workOrders: ParsedWorkOrder[];
  stages: Record<MakeReadyStage, ParsedWorkOrder | null>;
  /** Stage slots whose assigned order is Completed/Closed. */
  completedStageCount: number;
  isComplete: boolean;
  urgency: MoveInUrgency;
}

/**
 * Stage-slot preference: completed beats not-completed (an old finished order
 * outranks a fresh open re-file of the same stage); among equals, later
 * completedAt wins, then later reportedAt.
 */
function preferredCandidate(current: ParsedWorkOrder, next: ParsedWorkOrder): ParsedWorkOrder {
  const currentDone = isCompleted(current);
  const nextDone = isCompleted(next);
  if (currentDone !== nextDone) return currentDone ? current : next;
  const currentCompleted = current.completedAt ?? Number.NEGATIVE_INFINITY;
  const nextCompleted = next.completedAt ?? Number.NEGATIVE_INFINITY;
  if (currentCompleted !== nextCompleted) return nextCompleted > currentCompleted ? next : current;
  const currentReported = current.reportedAt ?? Number.NEGATIVE_INFINITY;
  const nextReported = next.reportedAt ?? Number.NEGATIVE_INFINITY;
  return nextReported > currentReported ? next : current;
}

export function buildMakeReadyGroups(input: {
  workOrders: ParsedWorkOrder[];
  unitIndex: UnitIndex;
  nowMs: number;
}): MakeReadyGroup[] {
  const { workOrders, unitIndex, nowMs } = input;

  // Defensive: callers should pass the make-ready set already, but a stray
  // regular order must never claim a stage slot.
  const byUnit = new Map<string, ParsedWorkOrder[]>();
  for (const wo of workOrders) {
    if (!wo.isMakeReady) continue;
    const key = wo.unitNumber || "Unassigned Unit";
    const list = byUnit.get(key);
    if (list) list.push(wo);
    else byUnit.set(key, [wo]);
  }

  const groups: MakeReadyGroup[] = [];
  for (const [unitNumber, list] of byUnit) {
    // Newest first (null reportedAt last) so latestDateMs is just the head.
    const sorted = [...list].sort((a, b) => {
      if (a.reportedAt === null && b.reportedAt === null) return 0;
      if (a.reportedAt === null) return 1;
      if (b.reportedAt === null) return -1;
      return b.reportedAt - a.reportedAt;
    });

    const stages: Record<MakeReadyStage, ParsedWorkOrder | null> = {
      trashOut: null,
      punch: null,
      flooring: null,
      finalInspection: null,
      cleaning: null,
      rekey: null,
    };
    for (const wo of sorted) {
      for (const stage of stagesOf(wo.title)) {
        const current = stages[stage];
        stages[stage] = current === null ? wo : preferredCandidate(current, wo);
      }
    }

    const completedStageCount = MAKE_READY_STAGES.reduce((count, stage) => {
      const wo = stages[stage];
      return wo !== null && isCompleted(wo) ? count + 1 : count;
    }, 0);

    const facts = unitIndex.get(unitNumber);
    const moveInAt = facts?.moveInAt ?? null;
    groups.push({
      unitNumber,
      moveInAt,
      unitStatus: facts?.availability || "—",
      classification: facts?.classification || "—",
      latestDateMs: sorted[0]?.reportedAt ?? null,
      workOrders: sorted,
      stages,
      completedStageCount,
      isComplete: completedStageCount >= MAKE_READY_STAGES.length,
      urgency: moveInUrgency(moveInAt, nowMs),
    });
  }

  // Dated units first (soonest move-in on top); undated sink to the bottom.
  groups.sort((a, b) => {
    if (a.moveInAt !== null && b.moveInAt !== null && a.moveInAt !== b.moveInAt) {
      return a.moveInAt - b.moveInAt;
    }
    if ((a.moveInAt === null) !== (b.moveInAt === null)) return a.moveInAt === null ? 1 : -1;
    return a.unitNumber.toLowerCase().localeCompare(b.unitNumber.toLowerCase());
  });
  return groups;
}

/** True when a stage slot is claimed by a Completed/Closed order. */
export function isStageCompleted(wo: ParsedWorkOrder | null): boolean {
  return wo !== null && isCompleted(wo);
}

/**
 * ResMan has flipped the unit's availability to "Ready" — the turn is done in
 * the system of record even if make-ready tickets were never closed out. The
 * board hides these behind its "show completed" toggle; the SCHEDULE excludes
 * them unconditionally, because a stale ticket on a Ready unit is noise on a
 * planning view. (Exact-match on the ResMan availability text, same as the
 * Swift rule this ports.)
 */
export function unitIsReady(g: Pick<MakeReadyGroup, "unitStatus">): boolean {
  return g.unitStatus === "Ready";
}

/** The stage a turn is currently working — the first slot not yet completed —
 *  or null when every stage is done. */
export function currentStageOf(g: MakeReadyGroup): MakeReadyStage | null {
  return MAKE_READY_STAGES.find((s) => !isStageCompleted(g.stages[s])) ?? null;
}

// ── Quick filters ───────────────────────────────────────────────────────────

export type MakeReadyQuickFilter = "all" | "atRisk" | "dueThisWeek" | "incomplete" | "noMoveInDate";

const AT_RISK_URGENCIES = new Set<MoveInUrgency>(["missingDate", "overdue", "today", "nextSevenDays"]);

export function quickFilterIncludes(f: MakeReadyQuickFilter, g: MakeReadyGroup): boolean {
  switch (f) {
    case "all":
      return true;
    case "atRisk":
      return !g.isComplete && AT_RISK_URGENCIES.has(g.urgency);
    case "dueThisWeek":
      return g.urgency === "today" || g.urgency === "nextSevenDays";
    case "incomplete":
      return !g.isComplete;
    case "noMoveInDate":
      return g.moveInAt === null;
  }
}

export function quickFilterCounts(groups: MakeReadyGroup[]): Record<MakeReadyQuickFilter, number> {
  const counts: Record<MakeReadyQuickFilter, number> = {
    all: 0,
    atRisk: 0,
    dueThisWeek: 0,
    incomplete: 0,
    noMoveInDate: 0,
  };
  for (const g of groups) {
    for (const f of Object.keys(counts) as MakeReadyQuickFilter[]) {
      if (quickFilterIncludes(f, g)) counts[f] += 1;
    }
  }
  return counts;
}

// ── Completed-turn helpers (score cards) ────────────────────────────────────

/** A turn counts as "fully completed" only when every stage slot is claimed
 *  AND completed — five of six done is still an open turn. */
export function isFullyCompletedTurn(g: MakeReadyGroup): boolean {
  return MAKE_READY_STAGES.every((stage) => g.stages[stage] !== null) && g.completedStageCount === MAKE_READY_STAGES.length;
}

/** Max completedAt across the stage orders — null if any slot or date is
 *  missing (a turn without a full date set has no finish date). */
export function latestCompletedDate(g: MakeReadyGroup): number | null {
  let latest: number | null = null;
  for (const stage of MAKE_READY_STAGES) {
    const completedAt = g.stages[stage]?.completedAt ?? null;
    if (completedAt === null) return null;
    if (latest === null || completedAt > latest) latest = completedAt;
  }
  return latest;
}

/** Min reportedAt across the group's orders (the turn's start). */
export function earliestReportedDate(g: MakeReadyGroup): number | null {
  let earliest: number | null = null;
  for (const wo of g.workOrders) {
    if (wo.reportedAt === null) continue;
    if (earliest === null || wo.reportedAt < earliest) earliest = wo.reportedAt;
  }
  return earliest;
}

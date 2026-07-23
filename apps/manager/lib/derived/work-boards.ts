import {
  buildMakeReadyGroups,
  calendarDaysBetween,
  currentStageOf,
  isCallbackSignal,
  isClosedWorkOrder,
  isOpenWorkOrder,
  isStageCompleted,
  makeUnitIndex,
  MAKE_READY_STAGES,
  parseAll,
  priorityRank,
  sameCalendarMonth,
  sameCalendarWeek,
  unitIsReady,
  urgencyShowsBadge,
  WORK_ORDER_PRIORITY_ORDER,
  workOrderAgeDays,
  type MakeReadyGroup,
  type MakeReadyStage,
  type MoveInUrgency,
  type ParsedWorkOrder,
  type UnitIndex,
} from "@emberly/core";
import type { ResmanUnit } from "@/lib/api/units";
import type { WorkOrder } from "@/lib/api/work-orders";

/**
 * The Work tab's derived engine — the manager's read-only cut of the shared
 * work-order engine in @emberly/core (promoted out of the maintenance app so
 * both surfaces answer "what's broken" and "which units are turning" from one
 * set of rules).
 *
 * Everything here is PURE and i18n-free: rows carry machine values (stage keys,
 * urgency brackets, priority strings) and the screen translates them. Make-
 * ready tickets never appear on the Open/Closed boards — the promoted
 * isMakeReadyCategory fold plus isOpen/isClosedWorkOrder enforce that rule.
 */

// ── Shared parse ────────────────────────────────────────────────────────────

export interface WorkData {
  parsed: ParsedWorkOrder[];
  unitIndex: UnitIndex;
}

/** Parse once per data change; every board below reads THIS. */
export function buildWorkData(rows: WorkOrder[], units: ResmanUnit[]): WorkData {
  return { parsed: parseAll(rows), unitIndex: makeUnitIndex(units) };
}

// ── Open board ──────────────────────────────────────────────────────────────

export interface OpenRow {
  id: string;
  number: string;
  unitNumber: string;
  category: string;
  title: string;
  status: string;
  priority: string;
  ageDays: number;
  technicianDisplay: string;
  /** Flagged by the shared callback engine ("possible" or "confirmed"). */
  isCallback: boolean;
}

/** One priority band of the open board (Emergency first, unknown folded into Normal). */
export interface PriorityBand {
  priority: string;
  rows: OpenRow[];
}

export interface OpenBoard {
  bands: PriorityBand[];
  openCount: number;
  emergencyCount: number;
  /** Mean age in whole days across open rows; 0 when the board is empty. */
  avgAgeDays: number;
  callbackCount: number;
}

function openRow(wo: ParsedWorkOrder, nowMs: number): OpenRow {
  return {
    id: wo.id,
    number: wo.number,
    unitNumber: wo.unitNumber,
    category: wo.raw.category,
    title: wo.title,
    status: wo.status,
    priority: wo.priority,
    ageDays: workOrderAgeDays(wo, nowMs),
    technicianDisplay: wo.technicianDisplay,
    isCallback: isCallbackSignal(wo),
  };
}

/**
 * Open work, banded by priority. Within a band the oldest ticket leads — a
 * manager reads this top-down as "what has been waiting longest".
 */
export function buildOpenBoard(data: WorkData, nowMs: number): OpenBoard {
  const rows = data.parsed.filter(isOpenWorkOrder).map((wo) => openRow(wo, nowMs));

  const byPriority = new Map<string, OpenRow[]>();
  for (const row of rows) {
    // Unknown priorities band with Normal rather than inventing a band.
    const key = WORK_ORDER_PRIORITY_ORDER.includes(row.priority) ? row.priority : "Normal";
    const list = byPriority.get(key);
    if (list) list.push(row);
    else byPriority.set(key, [row]);
  }

  const bands: PriorityBand[] = [...byPriority.entries()]
    .map(([priority, bandRows]) => ({
      priority,
      rows: bandRows.sort((a, b) => b.ageDays - a.ageDays || a.unitNumber.localeCompare(b.unitNumber)),
    }))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

  const ageTotal = rows.reduce((sum, r) => sum + r.ageDays, 0);
  return {
    bands,
    openCount: rows.length,
    emergencyCount: rows.filter((r) => r.priority === "Emergency").length,
    avgAgeDays: rows.length === 0 ? 0 : Math.round(ageTotal / rows.length),
    callbackCount: rows.filter((r) => r.isCallback).length,
  };
}

// ── Open board, grouped by unit (mockup frame 03) ───────────────────────────

/** A dot on a unit's timeline rail — its tone is the order's priority, or
 *  "closed" for a resolved past order. */
export type TimelineTone = "emergency" | "high" | "normal" | "low" | "closed";
export interface UnitTimelineDot {
  atMs: number;
  tone: TimelineTone;
}

/**
 * One unit's card on the Open board: its open orders compacted together, the
 * lifetime count, and — for units with a history — the timeline rail.
 */
export interface OpenUnitGroup {
  unitNumber: string;
  classification: string;
  openCount: number;
  /** All orders ever filed on this unit (open + closed) in the mirror. */
  totalCount: number;
  closedCount: number;
  lastClosedAt: number | null;
  anyCallback: boolean;
  /** Open orders, most urgent (then oldest) first. */
  lines: OpenRow[];
  /** Present only when the unit has ≥2 dated orders to plot. */
  timeline: { startMs: number; endMs: number; dots: UnitTimelineDot[] } | null;
}

function timelineTone(wo: ParsedWorkOrder): TimelineTone {
  if (isClosedWorkOrder(wo)) return "closed";
  const p = wo.priority.toLowerCase();
  if (p === "emergency") return "emergency";
  if (p === "high") return "high";
  if (p === "low") return "low";
  return "normal";
}

/**
 * The Open board as unit cards rather than priority bands: orders compact under
 * their unit number, carrying the lifetime count, classification, callback
 * flag, and a timeline rail of the unit's whole order history. Units are led by
 * their most urgent open order (emergencies first), then by how many are open.
 */
export function buildOpenUnitGroups(data: WorkData, nowMs: number): OpenUnitGroup[] {
  const open = data.parsed.filter(isOpenWorkOrder);
  const byUnit = new Map<string, ParsedWorkOrder[]>();
  for (const wo of open) {
    const arr = byUnit.get(wo.unitNumber);
    if (arr) arr.push(wo);
    else byUnit.set(wo.unitNumber, [wo]);
  }

  const groups: OpenUnitGroup[] = [...byUnit.entries()].map(([unitNumber, openOrders]) => {
    const allForUnit =
      unitNumber === "" ? openOrders : data.parsed.filter((wo) => wo.unitNumber === unitNumber);
    const closed = allForUnit.filter(isClosedWorkOrder);
    const lastClosed = closed
      .filter((wo) => wo.completedAt !== null)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
    const dots: UnitTimelineDot[] = allForUnit
      .filter((wo) => wo.reportedAt !== null)
      .sort((a, b) => (a.reportedAt ?? 0) - (b.reportedAt ?? 0))
      .map((wo) => ({ atMs: wo.reportedAt as number, tone: timelineTone(wo) }));
    const lines = openOrders
      .slice()
      .sort(
        (a, b) =>
          priorityRank(a.priority) - priorityRank(b.priority) ||
          workOrderAgeDays(b, nowMs) - workOrderAgeDays(a, nowMs),
      )
      .map((wo) => openRow(wo, nowMs));
    return {
      unitNumber,
      classification: data.unitIndex.get(unitNumber)?.classification ?? "",
      openCount: openOrders.length,
      totalCount: allForUnit.length,
      closedCount: closed.length,
      lastClosedAt: lastClosed?.completedAt ?? null,
      anyCallback: openOrders.some(isCallbackSignal),
      lines,
      timeline:
        allForUnit.length >= 2 && dots.length >= 2 ? { startMs: dots[0].atMs, endMs: nowMs, dots } : null,
    };
  });

  const topRank = (g: OpenUnitGroup) =>
    g.lines.length === 0 ? 99 : Math.min(...g.lines.map((l) => priorityRank(l.priority)));
  return groups.sort(
    (a, b) => topRank(a) - topRank(b) || b.openCount - a.openCount || a.unitNumber.localeCompare(b.unitNumber),
  );
}

// ── Make-ready board ────────────────────────────────────────────────────────

/**
 * A turn stage counts as BLOCKED when its ticket is filed but stalled: still
 * open after two weeks, or explicitly parked ("On Hold" / "Not Started").
 * That is the manager-visible answer to "why isn't this unit moving".
 */
export const STALLED_STAGE_DAYS = 14;
const PARKED_STATUSES = new Set(["On Hold", "Not Started"]);

export interface MakeReadyRow {
  unitNumber: string;
  unitStatus: string;
  classification: string;
  moveInAt: number | null;
  urgency: MoveInUrgency;
  /** True for the urgent-now brackets (overdue / today / next seven days). */
  showsUrgency: boolean;
  completedStages: number;
  totalStages: number;
  /** First stage not yet complete, or null when the turn is done. */
  currentStage: MakeReadyStage | null;
  blockedStages: MakeReadyStage[];
  isComplete: boolean;
  /** ResMan has flipped the unit to "Ready" regardless of ticket state. */
  isReady: boolean;
}

export interface MakeReadyBoard {
  rows: MakeReadyRow[];
  /** Turns with work still to do (and not already flipped to Ready). */
  turnsInProgress: number;
  /** Units ResMan calls Ready, or whose six stages are all complete. */
  readyUnits: number;
  /** In-progress turns whose move-in is today or already past. */
  lateForMoveIn: number;
  blockedCount: number;
}

function blockedStagesOf(g: MakeReadyGroup, nowMs: number): MakeReadyStage[] {
  const blocked: MakeReadyStage[] = [];
  for (const stage of MAKE_READY_STAGES) {
    const wo = g.stages[stage];
    if (wo === null || isStageCompleted(wo)) continue;
    const stalled =
      PARKED_STATUSES.has(wo.status) ||
      (wo.reportedAt !== null && calendarDaysBetween(wo.reportedAt, nowMs) >= STALLED_STAGE_DAYS);
    if (stalled) blocked.push(stage);
  }
  return blocked;
}

/**
 * The six-stage turn board, ordered by the engine (soonest move-in first,
 * undated last). Rows keep the machine urgency bracket; the screen picks copy.
 */
export function buildMakeReadyBoard(data: WorkData, nowMs: number): MakeReadyBoard {
  const groups = buildMakeReadyGroups({
    workOrders: data.parsed.filter((wo) => wo.isMakeReady),
    unitIndex: data.unitIndex,
    nowMs,
  });

  const rows: MakeReadyRow[] = groups.map((g) => ({
    unitNumber: g.unitNumber,
    unitStatus: g.unitStatus,
    classification: g.classification,
    moveInAt: g.moveInAt,
    urgency: g.urgency,
    showsUrgency: urgencyShowsBadge(g.urgency),
    completedStages: g.completedStageCount,
    totalStages: MAKE_READY_STAGES.length,
    currentStage: currentStageOf(g),
    blockedStages: blockedStagesOf(g, nowMs),
    isComplete: g.isComplete,
    isReady: unitIsReady(g),
  }));

  const inProgress = rows.filter((r) => !r.isComplete && !r.isReady);
  return {
    rows,
    turnsInProgress: inProgress.length,
    readyUnits: rows.filter((r) => r.isComplete || r.isReady).length,
    lateForMoveIn: inProgress.filter((r) => r.urgency === "overdue" || r.urgency === "today").length,
    blockedCount: inProgress.filter((r) => r.blockedStages.length > 0).length,
  };
}

// ── Closed board ────────────────────────────────────────────────────────────

export interface ClosedRow {
  id: string;
  number: string;
  unitNumber: string;
  category: string;
  title: string;
  status: string;
  technicianDisplay: string;
  completedAt: number | null;
  /** Whole days reported→completed, when both dates exist. */
  daysToClose: number | null;
  isCallback: boolean;
}

export interface ClosedBoard {
  rows: ClosedRow[];
  closedThisWeek: number;
  closedThisMonth: number;
  /** Mean days-to-close over rows that have both dates; null when none do. */
  avgDaysToClose: number | null;
}

/** How far back the closed board lists rows (metrics use calendar buckets). */
export const CLOSED_WINDOW_DAYS = 60;

/** Recently closed work, newest first. Make-ready turns are excluded. */
export function buildClosedBoard(data: WorkData, nowMs: number): ClosedBoard {
  const closed = data.parsed.filter(isClosedWorkOrder);

  const rows: ClosedRow[] = closed
    .filter(
      (wo) =>
        wo.completedAt !== null && calendarDaysBetween(wo.completedAt, nowMs) <= CLOSED_WINDOW_DAYS,
    )
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .map((wo) => ({
      id: wo.id,
      number: wo.number,
      unitNumber: wo.unitNumber,
      category: wo.raw.category,
      title: wo.title,
      status: wo.status,
      technicianDisplay: wo.technicianDisplay,
      completedAt: wo.completedAt,
      daysToClose: wo.daysToComplete,
      isCallback: isCallbackSignal(wo),
    }));

  const dated = closed.filter((wo) => wo.completedAt !== null);
  const withDuration = dated.filter((wo) => wo.daysToComplete !== null);
  const durationTotal = withDuration.reduce((sum, wo) => sum + (wo.daysToComplete ?? 0), 0);

  return {
    rows,
    closedThisWeek: dated.filter((wo) => sameCalendarWeek(wo.completedAt as number, nowMs)).length,
    closedThisMonth: dated.filter((wo) => sameCalendarMonth(wo.completedAt as number, nowMs)).length,
    avgDaysToClose:
      withDuration.length === 0 ? null : Math.round((durationTotal / withDuration.length) * 10) / 10,
  };
}

// ── Today card snapshot ─────────────────────────────────────────────────────

export interface MakeReadySnapshot {
  turnsInProgress: number;
  /** Units whose ResMan move-in date falls in the current (Monday-anchored) week. */
  moveInsThisWeek: number;
  lateForMoveIn: number;
  blockedCount: number;
  readyUnits: number;
}

/**
 * The Today board's make-ready line. Returns null when there is nothing to say
 * (no turns at all) so LinkedFeatureCard keeps hiding on a cold cache rather
 * than rendering a row of zeros.
 */
export function makeReadySnapshot(data: WorkData, nowMs: number): MakeReadySnapshot | null {
  const board = buildMakeReadyBoard(data, nowMs);
  if (board.rows.length === 0) return null;

  let moveInsThisWeek = 0;
  for (const facts of data.unitIndex.values()) {
    if (facts.moveInAt !== null && sameCalendarWeek(facts.moveInAt, nowMs)) moveInsThisWeek += 1;
  }

  return {
    turnsInProgress: board.turnsInProgress,
    moveInsThisWeek,
    lateForMoveIn: board.lateForMoveIn,
    blockedCount: board.blockedCount,
    readyUnits: board.readyUnits,
  };
}

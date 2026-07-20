/**
 * Unit hot-spot scoring. Port of the Swift hot-spot board: weight each unit's
 * recent maintenance load (volume, recency, open age, callbacks, duplicates)
 * into one score, keep only units that clear the noise floor, and rank them.
 *
 * Two exclusions keep turns out of the picture: the isMakeReady flag, plus a
 * text sweep over title+notes (staff sometimes file turn work as regular
 * orders); and a per-unit "boundary" date so orders from the PREVIOUS
 * tenancy don't haunt the current one.
 */

import type { ParsedWorkOrder, UnitIndex } from "./types";
import { addDays, calendarDaysBetween, startOfDay } from "./time";

export interface HotSpotRow {
  unitNumber: string;
  classification: string;
  score: number;
  riskLevel: "High" | "Watch" | "Monitor";
  totalCount: number;
  recentCount: number;
  openCount: number;
  callbackCount: number;
  duplicateCount: number;
  oldestOpenDays: number | null;
  /** "N days occupied" (non-vacant only; "1 day occupied" singular). */
  occupiedDaysText: string | null;
  sinceLabel: "Since Move In" | "Since Move Out" | "Since Available";
  lastActivityMs: number | null;
  /** Recent (90-day) orders, status-rank/activity/number sorted. */
  detail: ParsedWorkOrder[];
  /** Detail subset with a callback signal. */
  callbackDetail: ParsedWorkOrder[];
  /** Detail subset flagged duplicate. */
  duplicateDetail: ParsedWorkOrder[];
}

/** Open-mode membership (local copy — filtering.ts is off-limits here). */
const OPEN_STATUSES = new Set(["Open", "In Progress", "Not Started", "On Hold", "Submitted", "Scheduled"]);

function isOpenMode(wo: ParsedWorkOrder): boolean {
  return OPEN_STATUSES.has(wo.status) && !wo.isMakeReady;
}

function hasCallbackSignal(wo: ParsedWorkOrder): boolean {
  return wo.callbackStatus === "possible" || wo.callbackStatus === "confirmed";
}

/**
 * Text sweep for turn work filed as regular orders: lowercase title+notes,
 * squash punctuation/newlines to spaces, wrap in spaces so word-boundary
 * matching is a plain substring check.
 */
function looksLikeMakeReadyText(wo: ParsedWorkOrder): boolean {
  const normalized = ` ${`${wo.title}\n${wo.raw.notes}`
    .toLowerCase()
    .replace(/[\r\n\t.,;:()]/g, " ")
    .replace(/ +/g, " ")
    .trim()} `;
  return (
    normalized.includes(" make ready ") ||
    normalized.includes(" make-ready ") ||
    normalized.includes(" makeready ")
  );
}

/** Best activity date for recency/boundary checks. */
function activityDate(wo: ParsedWorkOrder): number | null {
  return wo.reportedAt ?? wo.completedAt ?? wo.scheduledAt;
}

/** Detail-sort status rank — workflow-ish order with closed states sunk. */
const DETAIL_STATUS_RANK: Record<string, number> = {
  Open: 0,
  "In Progress": 1,
  Submitted: 2,
  Scheduled: 3,
  "On Hold": 4,
  "Not Started": 5,
  Completed: 10,
  Closed: 11,
  Cancelled: 12,
  Canceled: 12,
};

function detailStatusRank(status: string): number {
  return DETAIL_STATUS_RANK[status] ?? 20;
}

function detailSort(a: ParsedWorkOrder, b: ParsedWorkOrder): number {
  const rankDiff = detailStatusRank(a.status) - detailStatusRank(b.status);
  if (rankDiff !== 0) return rankDiff;
  const aActivity = activityDate(a);
  const bActivity = activityDate(b);
  if (aActivity !== bActivity) {
    if (aActivity === null) return 1;
    if (bActivity === null) return -1;
    return bActivity - aActivity;
  }
  return a.number.localeCompare(b.number, undefined, { numeric: true });
}

export function buildHotSpotRows(input: {
  workOrders: ParsedWorkOrder[];
  unitIndex: UnitIndex;
  nowMs: number;
}): HotSpotRow[] {
  const { workOrders, unitIndex, nowMs } = input;
  const today = startOfDay(nowMs);
  const recentStart = addDays(today, -90);

  const byUnit = new Map<string, ParsedWorkOrder[]>();
  for (const wo of workOrders) {
    if (wo.isMakeReady || looksLikeMakeReadyText(wo)) continue;
    const key = wo.unitNumber || "Unassigned Unit";
    const list = byUnit.get(key);
    if (list) list.push(wo);
    else byUnit.set(key, [wo]);
  }

  const rows: HotSpotRow[] = [];
  for (const [unitNumber, list] of byUnit) {
    const facts = unitIndex.get(unitNumber);
    const isVacant = (facts?.occupancyStatus ?? "").trim().toLowerCase() === "vacant";

    // Boundary = start of the current tenancy chapter. Vacant units reset at
    // move-out (no dateAvailable in the mirror — moveOut is all we have);
    // occupied units reset at lease start, falling back to move-in. MAX of
    // the candidates so the latest reset wins.
    const boundaryCandidates: number[] = [];
    if (isVacant) {
      if (facts?.moveOutAt != null) boundaryCandidates.push(startOfDay(facts.moveOutAt));
    } else {
      const occupiedSince = facts?.leaseStartAt ?? facts?.moveInAt ?? null;
      if (occupiedSince != null) boundaryCandidates.push(startOfDay(occupiedSince));
    }
    const boundary = boundaryCandidates.length > 0 ? Math.max(...boundaryCandidates) : null;

    let totalCount = 0;
    let recentCount = 0;
    let openCount = 0;
    let callbackCount = 0;
    let duplicateCount = 0;
    let oldestOpenDays: number | null = null;
    let lastActivityMs: number | null = null;
    const detail: ParsedWorkOrder[] = [];

    for (const wo of list) {
      const activity = activityDate(wo);
      // Undated orders can't be placed, so they stay in (never silently drop
      // work); dated orders must fall on/after the boundary.
      if (boundary !== null && activity !== null && startOfDay(activity) < boundary) continue;

      totalCount += 1;
      if ((activity ?? Number.NEGATIVE_INFINITY) >= recentStart) {
        recentCount += 1;
        detail.push(wo);
      }
      if (isOpenMode(wo)) {
        openCount += 1;
        if (wo.reportedAt !== null) {
          const openDays = Math.max(calendarDaysBetween(wo.reportedAt, today), 0);
          if (oldestOpenDays === null || openDays > oldestOpenDays) oldestOpenDays = openDays;
        }
      }
      if (hasCallbackSignal(wo)) callbackCount += 1;
      if (wo.isDuplicate) duplicateCount += 1;
      if (activity !== null && (lastActivityMs === null || activity > lastActivityMs)) {
        lastActivityMs = activity;
      }
    }

    // Score: volume (first order is free), recency ×2, open ×4, callbacks ×6,
    // duplicates ×3, plus an age kicker for stale open work.
    const ageWeight = oldestOpenDays !== null && oldestOpenDays >= 14 ? 5 : oldestOpenDays !== null && oldestOpenDays >= 7 ? 2 : 0;
    const score =
      Math.max(totalCount - 1, 0) +
      recentCount * 2 +
      openCount * 4 +
      callbackCount * 6 +
      duplicateCount * 3 +
      ageWeight;

    // Noise floor: a real pattern needs both a score AND a corroborating count.
    const qualifies =
      score >= 10 &&
      (totalCount >= 3 || recentCount >= 2 || openCount >= 2 || callbackCount > 0 || duplicateCount > 0);
    if (!qualifies) continue;

    const riskLevel: HotSpotRow["riskLevel"] =
      score >= 18 || (callbackCount > 0 && openCount > 0)
        ? "High"
        : score >= 10 || openCount >= 2 || callbackCount > 0
          ? "Watch"
          : "Monitor";

    let occupiedDaysText: string | null = null;
    if (!isVacant) {
      const occupiedSince = facts?.leaseStartAt ?? facts?.moveInAt ?? null;
      if (occupiedSince !== null) {
        const days = Math.max(calendarDaysBetween(occupiedSince, today), 0);
        occupiedDaysText = days === 1 ? "1 day occupied" : `${days.toLocaleString()} days occupied`;
      }
    }
    const sinceLabel: HotSpotRow["sinceLabel"] = !isVacant
      ? "Since Move In"
      : facts?.moveOutAt == null
        ? "Since Available"
        : "Since Move Out";

    detail.sort(detailSort);
    rows.push({
      unitNumber,
      classification: facts?.classification ?? "",
      score,
      riskLevel,
      totalCount,
      recentCount,
      openCount,
      callbackCount,
      duplicateCount,
      oldestOpenDays,
      occupiedDaysText,
      sinceLabel,
      lastActivityMs,
      detail,
      callbackDetail: detail.filter(hasCallbackSignal),
      duplicateDetail: detail.filter((wo) => wo.isDuplicate),
    });
  }

  rows.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    if (a.callbackCount !== b.callbackCount) return b.callbackCount - a.callbackCount;
    if (a.recentCount !== b.recentCount) return b.recentCount - a.recentCount;
    return a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true });
  });
  return rows;
}

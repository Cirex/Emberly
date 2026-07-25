import { isCallbackSignal } from "./filtering";
import {
  compareNumbers,
  compareNumericStrings,
  compareStrings,
  recentMoveInSort,
  sortOpenWorkOrders,
  type WorkOrderSortOption,
} from "./sort";
import { calendarDaysBetween, DAY_MS, startOfDay } from "./time";
import type { ParsedWorkOrder, UnitIndex } from "./types";

/**
 * Open-board unit groups — port of the SwiftUI open list's grouping +
 * openWorkOrderTimeline. One group per unit carries everything a card renders
 * (tag chips, technicians, dot timeline, rail tint, move-in marker) so the
 * view layer never touches raw rows.
 */

const UNASSIGNED_UNIT = "Unassigned Unit";
const TIMELINE_EVENT_CAP = 6;

export interface TimelineEvent {
  dayMs: number;
  workOrders: ParsedWorkOrder[];
  /** 0…1 along the rail; 0.5 for a lone same-day point. */
  position: number;
  signal: "callback" | "duplicate" | null;
  isFirstIssueAfterMoveIn: boolean;
}

export interface OpenWorkOrderGroup {
  /** wo.unitNumber, or "Unassigned Unit" when blank. */
  unitNumber: string;
  building: string;
  classification: string;
  /** First (sorted) work order's reportedAt. */
  latestDateMs: number | null;
  /** One duplicate is just the original; a possible-duplicate PAIR needs ≥2. */
  hasPossibleDuplicate: boolean;
  callbackWorkOrderIds: string[];
  /** Distinct display techs minus "Unassigned", sorted asc. */
  technicians: string[];
  topTags: { tag: string; count: number; signal: "callback" | "duplicate" | null }[];
  workOrders: ParsedWorkOrder[];
  /** facts.moveInAt ?? leaseStartAt ?? -Infinity (missing sorts last descending). */
  recentMoveInSort: number;
  timeline: TimelineEvent[];
  /** Events beyond the 6-dot cap. */
  timelineOverflow: number;
  railTint: "blocked" | "attention" | "warning" | "secondary";
  /** Present only when the move-in is real, past, and ≤ 30 days old. */
  moveIn: { dayMs: number; daysAgo: number } | null;
  firstIssueAfterMoveIn: { eventIndex: number; elapsedDays: number } | null;
}

export function buildOpenGroups(input: {
  workOrders: ParsedWorkOrder[];
  option: WorkOrderSortOption;
  unitIndex: UnitIndex;
  nowMs: number;
}): OpenWorkOrderGroup[] {
  const { option, unitIndex, nowMs } = input;

  const byUnit = new Map<string, ParsedWorkOrder[]>();
  for (const wo of input.workOrders) {
    const key = wo.unitNumber.trim().length > 0 ? wo.unitNumber : UNASSIGNED_UNIT;
    const bucket = byUnit.get(key);
    if (bucket) bucket.push(wo);
    else byUnit.set(key, [wo]);
  }

  const groups: OpenWorkOrderGroup[] = [];
  for (const [unitNumber, members] of byUnit) {
    const workOrders = sortOpenWorkOrders(members, option, unitIndex);
    const facts = unitIndex.get(unitNumber);

    // Tag chips: counted per work order (a wo's duplicate tags count once),
    // callback signal outranks duplicate, top 4 by count then name.
    const tagCounts = new Map<string, number>();
    const callbackTags = new Set<string>();
    const duplicateTags = new Set<string>();
    let duplicateCount = 0;
    const callbackWorkOrderIds: string[] = [];
    const technicianSet = new Set<string>();
    for (const wo of workOrders) {
      const callback = isCallbackSignal(wo);
      if (callback) callbackWorkOrderIds.push(wo.id);
      if (wo.isDuplicate) duplicateCount += 1;
      if (wo.technicianDisplay !== "Unassigned") technicianSet.add(wo.technicianDisplay);
      for (const tag of new Set(wo.tags)) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        if (callback) callbackTags.add(tag);
        if (wo.isDuplicate) duplicateTags.add(tag);
      }
    }
    const topTags = [...tagCounts.entries()]
      .map(([tag, count]) => ({
        tag,
        count,
        signal: callbackTags.has(tag)
          ? ("callback" as const)
          : duplicateTags.has(tag)
            ? ("duplicate" as const)
            : null,
      }))
      .sort((a, b) => b.count - a.count || a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()))
      .slice(0, 4);

    // Timeline: dated rows bucketed by calendar day, oldest first, capped at
    // six dots; the rail spans oldest day → max(newest day, today) so a stale
    // group visibly drifts left as time passes.
    const byDay = new Map<number, ParsedWorkOrder[]>();
    for (const wo of workOrders) {
      if (wo.reportedAt === null) continue;
      const day = startOfDay(wo.reportedAt);
      const bucket = byDay.get(day);
      if (bucket) bucket.push(wo);
      else byDay.set(day, [wo]);
    }
    const eventDays = [...byDay.keys()].sort((a, b) => a - b);
    const timelineOverflow = Math.max(0, eventDays.length - TIMELINE_EVENT_CAP);
    const timeline: TimelineEvent[] = eventDays.slice(0, TIMELINE_EVENT_CAP).map((dayMs) => {
      const dayWorkOrders = [...byDay.get(dayMs)!].sort(
        (a, b) =>
          compareNumbers(a.reportedAt ?? Infinity, b.reportedAt ?? Infinity) ||
          compareNumericStrings(a.number, b.number),
      );
      return {
        dayMs,
        workOrders: dayWorkOrders,
        position: 0,
        signal: dayWorkOrders.some(isCallbackSignal)
          ? ("callback" as const)
          : dayWorkOrders.some((wo) => wo.isDuplicate)
            ? ("duplicate" as const)
            : null,
        isFirstIssueAfterMoveIn: false,
      };
    });
    if (timeline.length > 0) {
      const firstDay = timeline[0].dayMs;
      const lastDay = Math.max(timeline[timeline.length - 1].dayMs, startOfDay(nowMs));
      const span = Math.max(lastDay - firstDay, DAY_MS);
      for (const event of timeline) {
        // A lone point with no elapsed span centers on the rail.
        event.position = lastDay === firstDay ? 0.5 : (event.dayMs - firstDay) / span;
      }
    }

    // Rail tint escalates with the OLDEST open issue's age.
    let railTint: OpenWorkOrderGroup["railTint"] = "secondary";
    if (timeline.length > 0) {
      const ageDays = calendarDaysBetween(timeline[0].dayMs, nowMs);
      railTint = ageDays >= 30 ? "blocked" : ageDays >= 14 ? "attention" : ageDays >= 7 ? "warning" : "secondary";
    }

    // Move-in marker + "first issue after move-in" callout: only for real,
    // past move-ins within the last 30 days, and only an event within 30 days
    // AFTER the move-in qualifies.
    let moveIn: OpenWorkOrderGroup["moveIn"] = null;
    let firstIssueAfterMoveIn: OpenWorkOrderGroup["firstIssueAfterMoveIn"] = null;
    if (facts?.moveInAt != null) {
      const moveInDay = startOfDay(facts.moveInAt);
      const today = startOfDay(nowMs);
      const daysAgo = calendarDaysBetween(moveInDay, today);
      if (moveInDay <= today && daysAgo <= 30) {
        moveIn = { dayMs: moveInDay, daysAgo };
        const eventIndex = timeline.findIndex(
          (event) => event.dayMs >= moveInDay && calendarDaysBetween(moveInDay, event.dayMs) <= 30,
        );
        if (eventIndex >= 0) {
          timeline[eventIndex].isFirstIssueAfterMoveIn = true;
          firstIssueAfterMoveIn = {
            eventIndex,
            elapsedDays: Math.max(calendarDaysBetween(moveInDay, timeline[eventIndex].dayMs), 0),
          };
        }
      }
    }

    groups.push({
      unitNumber,
      building: facts?.building.trim() ? facts.building : "—",
      classification: facts?.classification.trim() ? facts.classification : "—",
      latestDateMs: workOrders[0]?.reportedAt ?? null,
      hasPossibleDuplicate: duplicateCount >= 2,
      callbackWorkOrderIds,
      technicians: [...technicianSet].sort((a, b) => a.localeCompare(b)),
      topTags,
      workOrders,
      recentMoveInSort: workOrders.length > 0 ? recentMoveInSort(workOrders[0], unitIndex) : -Infinity,
      timeline,
      timelineOverflow,
      railTint,
      moveIn,
      firstIssueAfterMoveIn,
    });
  }

  return sortOpenGroups(groups, option);
}

/**
 * Relative label for the gap between adjacent timeline dots (Swift
 * timelineGapTitle): "same day" / "1 day" / "N days" / "N wk" / "N mo".
 */
export function timelineGapTitle(days: number): string {
  if (days <= 0) return "same day";
  if (days === 1) return "1 day";
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.max(Math.round(days / 7), 2)} wk`;
  return `${Math.max(Math.round(days / 30), 2)} mo`;
}

/**
 * Group-level ordering, keyed on each group's first (already-sorted) row.
 * Lives here rather than sort.ts so sort.ts needn't know the group shape.
 */
export function sortOpenGroups(
  groups: OpenWorkOrderGroup[],
  option: WorkOrderSortOption,
): OpenWorkOrderGroup[] {
  const sorted = [...groups];
  const first = (g: OpenWorkOrderGroup) => g.workOrders[0];
  switch (option) {
    case "dateReportedAscending":
      sorted.sort((a, b) =>
        compareNumbers(first(a)?.reportedAt ?? Infinity, first(b)?.reportedAt ?? Infinity),
      );
      break;
    case "recentMoveInDescending":
      // -Infinity sentinel keeps units with no move-in data last.
      sorted.sort((a, b) => compareNumbers(b.recentMoveInSort, a.recentMoveInSort));
      break;
    case "idAscending":
      sorted.sort((a, b) => compareNumericStrings(first(a).number, first(b).number));
      break;
    case "idDescending":
      sorted.sort((a, b) => compareNumericStrings(first(b).number, first(a).number));
      break;
    case "statusAscending":
      sorted.sort((a, b) =>
        compareStrings(first(a).status.toLowerCase(), first(b).status.toLowerCase()),
      );
      break;
    case "statusDescending":
      sorted.sort((a, b) =>
        compareStrings(first(b).status.toLowerCase(), first(a).status.toLowerCase()),
      );
      break;
    case "unitAscending":
      sorted.sort((a, b) => compareNumericStrings(a.unitNumber, b.unitNumber));
      break;
    case "unitDescending":
      sorted.sort((a, b) => compareNumericStrings(b.unitNumber, a.unitNumber));
      break;
    case "recentMoveInAscending":
      // Longest-tenured first. `recentMoveInSort` uses -Infinity for units with
      // no move-in data, which would otherwise sort them FIRST here — treat the
      // sentinel as unknown and push it to the end.
      sorted.sort((a, b) => {
        const av = a.recentMoveInSort === -Infinity ? Infinity : a.recentMoveInSort;
        const bv = b.recentMoveInSort === -Infinity ? Infinity : b.recentMoveInSort;
        return compareNumbers(av, bv);
      });
      break;
    case "dateCompletedAscending":
      sorted.sort((a, b) => compareNumbers(a.latestDateMs ?? Infinity, b.latestDateMs ?? Infinity));
      break;
    case "dateCompletedDescending":
    case "dateReportedDescending":
      sorted.sort((a, b) => compareNumbers(b.latestDateMs ?? -Infinity, a.latestDateMs ?? -Infinity));
      break;
  }
  return sorted;
}

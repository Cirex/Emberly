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
  /**
   * The rail's time domain — every `position` on this group maps into it.
   *
   * The START is the earlier of the first event and the move-in, NOT simply the
   * first event: a resident normally moves in and THEN reports problems, so a
   * domain anchored on the first work order cannot place the move-in at all. It
   * used to clamp to 0, stacking the marker on the first dot with a zero-width
   * bridge — the marker was drawn, invisibly, in exactly the case it is for.
   *
   * Published here rather than recomputed in the view, which had its own copy of
   * this arithmetic and so could disagree with the dots it was positioning.
   */
  railStartMs: number;
  railEndMs: number;
  /**
   * Present only when the move-in is real, past, and ≤ 30 days old — beyond that
   * a single old move-in would stretch the domain until every dot collapsed
   * against the right edge. `position` is 0…1 along the rail.
   */
  moveIn: { dayMs: number; daysAgo: number; position: number } | null;
  firstIssueAfterMoveIn: { eventIndex: number; elapsedDays: number } | null;
}

/**
 * Groups reused across rebuilds.
 *
 * A card is a gradient, a laid-out timeline rail and every ticket row in the
 * unit, and a data change used to hand each mounted one a brand-new `group`
 * object — so all of them re-rendered even though a sync typically touches a
 * handful of units. The group is a pure function of its members plus the
 * ordering and the calendar day, so an untouched unit can keep its object and
 * its memoized card can skip.
 *
 * The signature is built from RAW OBJECT IDENTITY, not from the work-order id.
 * A delta merge keeps the object for a row it did not touch and substitutes a
 * new one for a row it did — so identity is exactly the question being asked.
 * Keying on the id instead let an edited row keep its stale card, which is what
 * the reuse test caught. The engine signals go in too: those can change for the
 * same raw row when OTHER rows move.
 */

/**
 * A stable number per raw row object. Cheaper than trying to serialize a row,
 * and it says precisely what matters: is this the same object as last time?
 */
const rowTokens = new WeakMap<object, number>();
let nextRowToken = 1;
function rowToken(raw: object): number {
  let token = rowTokens.get(raw);
  if (token === undefined) {
    token = nextRowToken++;
    rowTokens.set(raw, token);
  }
  return token;
}
const groupCache = new Map<string, OpenWorkOrderGroup>();
/** Bounded so a long session cannot accumulate every past shape of the board. */
const GROUP_CACHE_MAX = 600;

function groupSignature(
  unitNumber: string,
  members: ParsedWorkOrder[],
  option: WorkOrderSortOption,
  dayKey: number,
  classification: string,
  moveInAt: number | null,
): string {
  let sig = `${unitNumber}|${option}|${dayKey}|${classification}|${moveInAt ?? ""}`;
  for (const wo of members) sig += `|${rowToken(wo.raw)}:${wo.callbackStatus}:${wo.isDuplicate ? 1 : 0}`;
  return sig;
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

  const dayKey = Math.floor(nowMs / (24 * 60 * 60 * 1000));
  const groups: OpenWorkOrderGroup[] = [];
  for (const [unitNumber, members] of byUnit) {
    const workOrders = sortOpenWorkOrders(members, option, unitIndex);
    const facts = unitIndex.get(unitNumber);

    const signature = groupSignature(
      unitNumber,
      workOrders,
      option,
      dayKey,
      facts?.classification ?? "",
      facts?.moveInAt ?? null,
    );
    const reused = groupCache.get(signature);
    if (reused) {
      groups.push(reused);
      continue;
    }

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
    // Move-in first: it can widen the rail's domain, so the positions below
    // depend on it. Only a real, past move-in inside the 30-day window counts.
    let moveInDay: number | null = null;
    if (facts?.moveInAt != null) {
      const day = startOfDay(facts.moveInAt);
      if (day <= startOfDay(nowMs) && calendarDaysBetween(day, startOfDay(nowMs)) <= 30) {
        moveInDay = day;
      }
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
    // The rail domain, and every position measured against it.
    let railStartMs = timeline.length > 0 ? timeline[0].dayMs : startOfDay(nowMs);
    let railEndMs = startOfDay(nowMs);
    if (timeline.length > 0) {
      if (moveInDay !== null) railStartMs = Math.min(railStartMs, moveInDay);
      railEndMs = Math.max(timeline[timeline.length - 1].dayMs, startOfDay(nowMs));
      const span = Math.max(railEndMs - railStartMs, DAY_MS);
      for (const event of timeline) {
        // A lone point with no elapsed span centers on the rail.
        event.position = railEndMs === railStartMs ? 0.5 : (event.dayMs - railStartMs) / span;
      }
    }
    const positionOf = (dayMs: number) =>
      railEndMs === railStartMs
        ? 0.5
        : (dayMs - railStartMs) / Math.max(railEndMs - railStartMs, DAY_MS);

    // Rail tint escalates with the OLDEST open issue's age.
    let railTint: OpenWorkOrderGroup["railTint"] = "secondary";
    if (timeline.length > 0) {
      const ageDays = calendarDaysBetween(timeline[0].dayMs, nowMs);
      railTint = ageDays >= 30 ? "blocked" : ageDays >= 14 ? "attention" : ageDays >= 7 ? "warning" : "secondary";
    }

    // Move-in marker + "first issue after move-in" callout. Only an event within
    // 30 days AFTER the move-in qualifies as the first issue.
    let moveIn: OpenWorkOrderGroup["moveIn"] = null;
    let firstIssueAfterMoveIn: OpenWorkOrderGroup["firstIssueAfterMoveIn"] = null;
    if (moveInDay !== null) {
      const day = moveInDay;
      moveIn = {
        dayMs: day,
        daysAgo: calendarDaysBetween(day, startOfDay(nowMs)),
        position: positionOf(day),
      };
      const eventIndex = timeline.findIndex(
        (event) => event.dayMs >= day && calendarDaysBetween(day, event.dayMs) <= 30,
      );
      if (eventIndex >= 0) {
        timeline[eventIndex].isFirstIssueAfterMoveIn = true;
        firstIssueAfterMoveIn = {
          eventIndex,
          elapsedDays: Math.max(calendarDaysBetween(day, timeline[eventIndex].dayMs), 0),
        };
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
      railStartMs,
      railEndMs,
      moveIn,
      firstIssueAfterMoveIn,
    });
    groupCache.set(signature, groups[groups.length - 1]);
  }
  while (groupCache.size > GROUP_CACHE_MAX) {
    const oldest = groupCache.keys().next().value;
    if (oldest === undefined) break;
    groupCache.delete(oldest);
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

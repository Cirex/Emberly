import { isCallbackSignal, isClosedWorkOrder, isOpenWorkOrder } from "@emberly/core";
import type {
  DisplayMode,
  FilterSets,
  ParsedWorkOrder,
  SignalFilter,
  UnitFacts,
  UnitIndex,
} from "./types";

/**
 * Faceted filter engine — port of WorkOrderFiltering.swift. One pass over the
 * parsed rows produces both the filtered list and every panel count, using
 * classic faceted semantics: each facet's counts apply all OTHER active
 * filters but never its own, so a chip always shows "what you'd get if you
 * toggled me" instead of collapsing to the current selection.
 */

/**
 * The open/closed status vocabulary and the callback-signal rule now live in
 * @emberly/core (both apps band their boards the same way); re-exported here
 * so this module's public API is unchanged.
 */
export { WORK_ORDER_CLOSED_STATUSES, WORK_ORDER_OPEN_STATUSES, isCallbackSignal } from "@emberly/core";

/**
 * Mode membership. Make-readies live on their own board, so open/closed/hot
 * spots all exclude them; the makeReady board ignores status entirely (a
 * completed make-ready still shows until the sync drops it).
 */
export function matchesDisplayMode(wo: ParsedWorkOrder, mode: DisplayMode): boolean {
  switch (mode) {
    case "open":
      return isOpenWorkOrder(wo);
    case "closed":
      return isClosedWorkOrder(wo);
    case "makeReady":
      return wo.isMakeReady;
    case "hotSpots":
      return !wo.isMakeReady;
  }
}

/** Substring test on the precomputed searchKey; caller passes trimmed+lowercased text. */
export function matchesSearch(wo: ParsedWorkOrder, normalizedSearch: string): boolean {
  return normalizedSearch.length === 0 || wo.searchKey.includes(normalizedSearch);
}

/**
 * Canonical occupancy chip value for a unit. ResMan's mirror is free-text-ish,
 * so fold the known spellings onto the four chips and pass anything else
 * through trimmed (empty when the unit is unknown).
 *
 * Deliberate deviation from Swift: ResMan files evictions under the occupancy
 * value "Notice", and only the lease status tells an eviction from a notice
 * to vacate (mirror of apps/security lib/stores/units.ts). So "Notice"
 * consults leaseStatus before falling through.
 */
export function normalizedOccupancyFilterValue(facts: UnitFacts | undefined): string {
  const trimmed = (facts?.occupancyStatus ?? "").trim();
  switch (trimmed.toLowerCase()) {
    case "occupied":
      return "Occupied";
    case "vacant":
      return "Vacant";
    case "under eviction":
    case "eviction":
      return "Eviction";
    case "notice to vacate":
    case "ntv":
      return "NTV";
    case "notice": {
      const lease = (facts?.leaseStatus ?? "").trim().toLowerCase();
      if (lease === "under eviction") return "Eviction";
      if (lease === "notice to vacate") return "NTV";
      return trimmed;
    }
    default:
      return trimmed;
  }
}

export type WorkOrderSignal = "Duplicate" | "Callback";

/**
 * Curated tag order for the filter panel — the maintenance team's triage
 * priority, not alphabetical. Unknown tags sort after every known one.
 */
export const WORK_ORDER_TAG_ORDER = [
  "HVAC",
  "Refrigerator",
  "Range",
  "Dishwasher",
  "Flooring",
  "Equipment",
  "Electrical",
  "Leaks",
  "Rodents",
  "Pests",
  "Clogs",
  "Air Filter",
  "Mold",
  "Broken Window",
  "Mail Box",
  "No Hot Water",
  "Set Out",
];

const TAG_ORDER_INDEX = new Map(WORK_ORDER_TAG_ORDER.map((tag, i) => [tag, i]));

export function sortedTagOptions(tags: Iterable<string>): string[] {
  return [...tags].sort((a, b) => {
    const ia = TAG_ORDER_INDEX.get(a) ?? WORK_ORDER_TAG_ORDER.length;
    const ib = TAG_ORDER_INDEX.get(b) ?? WORK_ORDER_TAG_ORDER.length;
    if (ia !== ib) return ia - ib;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
}

export interface FilterPanelData {
  statusCounts: Map<string, number>;
  classificationCounts: Map<string, number>;
  /** Excludes "Unassigned" — the panel has no chip for it. */
  technicianCounts: Map<string, number>;
  occupancyCounts: Map<string, number>;
  tagCounts: Map<string, number>;
  signalCounts: Map<WorkOrderSignal, number>;
  /** Rows matching all non-signal facets that carry at least one signal. */
  signalWorkOrderCount: number;
  /** Every display tech (≠ Unassigned) passing mode+search, sorted asc. */
  technicianOptions: string[];
  /** Observed tags in the curated panel order. */
  tagOptions: string[];
}

export function filterWorkOrders(input: {
  workOrders: ParsedWorkOrder[];
  mode: DisplayMode;
  search: string;
  filters: FilterSets;
  signalFilter: SignalFilter;
  unitIndex: UnitIndex;
}): { filtered: ParsedWorkOrder[]; panel: FilterPanelData } {
  const { workOrders, mode, filters, signalFilter, unitIndex } = input;
  const search = input.search.trim().toLowerCase();

  const statusFilter = new Set(filters.status);
  const classificationFilter = new Set(filters.classification);
  const technicianFilter = new Set(filters.technician);
  const occupancyFilter = new Set(filters.occupancy);
  const tagFilter = new Set(filters.tags);

  const statusCounts = new Map<string, number>();
  const classificationCounts = new Map<string, number>();
  const technicianCounts = new Map<string, number>();
  const occupancyCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const signalCounts = new Map<WorkOrderSignal, number>();
  let signalWorkOrderCount = 0;
  const technicianOptionSet = new Set<string>();
  const tagOptionSet = new Set<string>();
  const filtered: ParsedWorkOrder[] = [];

  const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const wo of workOrders) {
    // Base pass: mode + search gate everything, including the option lists.
    if (!matchesDisplayMode(wo, mode) || !matchesSearch(wo, search)) continue;

    const facts = unitIndex.get(wo.unitNumber);
    const classification = facts?.classification ?? "";
    const occupancy = normalizedOccupancyFilterValue(facts);
    const tagSet = new Set(wo.tags);

    if (wo.technicianDisplay !== "Unassigned") technicianOptionSet.add(wo.technicianDisplay);
    for (const tag of tagSet) tagOptionSet.add(tag);

    const matchesStatus = statusFilter.size === 0 || statusFilter.has(wo.status);
    const matchesClassification =
      classificationFilter.size === 0 || classificationFilter.has(classification);
    const matchesTechnician =
      technicianFilter.size === 0 || technicianFilter.has(wo.technicianDisplay);
    const matchesOccupancy = occupancyFilter.size === 0 || occupancyFilter.has(occupancy);
    let matchesTag = tagFilter.size === 0;
    if (!matchesTag) {
      for (const tag of tagFilter) {
        if (tagSet.has(tag)) {
          matchesTag = true;
          break;
        }
      }
    }
    const callback = isCallbackSignal(wo);
    // SignalFilter is the app's 3-state cycle replacing Swift's set-of-two:
    // "callbacks" behaves like {Callback}, "duplicates" like {Duplicate}.
    const matchesSignal =
      signalFilter === "all" || (signalFilter === "callbacks" ? callback : wo.isDuplicate);

    // Faceted counts: each facet applies every OTHER active filter but its own.
    if (matchesClassification && matchesTechnician && matchesOccupancy && matchesTag && matchesSignal) {
      bump(statusCounts, wo.status);
    }
    if (matchesStatus && matchesTechnician && matchesOccupancy && matchesTag && matchesSignal) {
      if (classification.length > 0) bump(classificationCounts, classification);
    }
    if (matchesStatus && matchesClassification && matchesOccupancy && matchesTag && matchesSignal) {
      if (wo.technicianDisplay !== "Unassigned") bump(technicianCounts, wo.technicianDisplay);
    }
    if (matchesStatus && matchesClassification && matchesTechnician && matchesTag && matchesSignal) {
      if (occupancy.length > 0) bump(occupancyCounts, occupancy);
    }
    if (matchesStatus && matchesClassification && matchesTechnician && matchesOccupancy && matchesSignal) {
      for (const tag of tagSet) bump(tagCounts, tag);
    }
    if (matchesStatus && matchesClassification && matchesTechnician && matchesOccupancy && matchesTag) {
      let carriesSignal = false;
      if (wo.isDuplicate) {
        bump(signalCounts, "Duplicate");
        carriesSignal = true;
      }
      if (callback) {
        bump(signalCounts, "Callback");
        carriesSignal = true;
      }
      if (carriesSignal) signalWorkOrderCount += 1;
    }

    if (
      matchesStatus &&
      matchesClassification &&
      matchesTechnician &&
      matchesOccupancy &&
      matchesTag &&
      matchesSignal
    ) {
      filtered.push(wo);
    }
  }

  return {
    filtered,
    panel: {
      statusCounts,
      classificationCounts,
      technicianCounts,
      occupancyCounts,
      tagCounts,
      signalCounts,
      signalWorkOrderCount,
      technicianOptions: [...technicianOptionSet].sort((a, b) => a.localeCompare(b)),
      tagOptions: sortedTagOptions(tagOptionSet),
    },
  };
}

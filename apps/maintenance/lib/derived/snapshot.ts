import type { ResmanUnit } from "@/lib/api/units";
import type { WorkOrder } from "@/lib/api/work-orders";
import { buildCallbackAnalytics, type CallbackAnalytics } from "./callbacks";
import { buildClosedRows, type ClosedWorkOrderRow } from "./closed-rows";
import { buildDaysToCloseDistribution, type DaysToCloseBucket, type DaysToCloseMetrics } from "./days-to-close";
import { filterWorkOrders, matchesDisplayMode, matchesSearch, type FilterPanelData } from "./filtering";
import { buildHotSpotRows, type HotSpotRow } from "./hot-spots";
import { buildMakeReadyGroups, quickFilterCounts, type MakeReadyGroup, type MakeReadyQuickFilter } from "./make-ready";
import { buildMonthlyClassification, type MonthlyClassificationSummary, type MonthlyMetrics } from "./monthly-classification";
import { buildOpenGroups, type OpenWorkOrderGroup } from "./open-groups";
import { parseAll } from "./parse";
import { buildSameWeekTimeline, type SameWeekMetrics, type SameWeekPoint } from "./same-week-timeline";
import { buildScoreCards, type ScoreCard } from "./score-cards";
import type { WorkOrderSortOption } from "./sort";
import { buildMonthlyTechnicianSummary, buildWeeklyTechnicianSummary, type TechnicianSummary } from "./technician-summary";
import {
  makeUnitIndex,
  type DisplayMode,
  type FilterSets,
  type ParsedWorkOrder,
  type SignalFilter,
  type UnitIndex,
} from "./types";

/**
 * The one immutable object the Work Orders screen renders from — the port of
 * WorkOrderDerivedSnapshot. Rebuilt only when its input signature changes;
 * a quiet data refresh that changes nothing re-renders nothing.
 *
 * Two cache levels, mirroring the Swift signature-driven scheduler:
 *  - level 1 (parse): raw rows → ParsedWorkOrder[] + unit index + by-unit map,
 *    keyed on (dataVersion, unitsVersion). Dates parse exactly once.
 *  - level 2 (view): the full snapshot, keyed on the complete signature.
 *
 * Filter scope is faithful to the Swift UI: open/closed modes carry their own
 * facet-filter sets; make-ready and hot-spots have no facet UI, so they see
 * search only.
 */

export interface SnapshotInput {
  workOrders: WorkOrder[];
  units: ResmanUnit[];
  dataVersion: number;
  unitsVersion: number;
  mode: DisplayMode;
  sortOption: WorkOrderSortOption;
  search: string;
  openFilters: FilterSets;
  closedFilters: FilterSets;
  signalFilter: SignalFilter;
  nowMs: number;
}

export interface DerivedSnapshot {
  mode: DisplayMode;
  /** The current mode's filtered list (what the list body renders). */
  visible: ParsedWorkOrder[];
  panel: FilterPanelData;
  scoreCards: ScoreCard[];
  openGroups: OpenWorkOrderGroup[];
  closedRows: ClosedWorkOrderRow[];
  makeReadyGroups: MakeReadyGroup[];
  makeReadyQuickCounts: Record<MakeReadyQuickFilter, number>;
  hotSpotRows: HotSpotRow[];
  weeklySummary: TechnicianSummary;
  monthlySummary: TechnicianSummary;
  monthlyClassification: { months: MonthlyClassificationSummary[]; metrics: MonthlyMetrics };
  sameWeek: { points: SameWeekPoint[]; metrics: SameWeekMetrics };
  daysToClose: { buckets: DaysToCloseBucket[]; metrics: DaysToCloseMetrics };
  callbacks: CallbackAnalytics;
  /** Same-unit index for "Related Work Orders" on the detail screen. */
  byUnit: Map<string, ParsedWorkOrder[]>;
  unitIndex: UnitIndex;
}

interface ParseCache {
  key: string;
  parsed: ParsedWorkOrder[];
  unitIndex: UnitIndex;
  byUnit: Map<string, ParsedWorkOrder[]>;
}

let parseCache: ParseCache | null = null;
// A few most-recent snapshots, keyed by the full memo key. It must hold more
// than one because the Work Orders screen and the Make Ready tab are BOTH
// mounted in the navigator and call buildSnapshot with different `mode` keys
// every data tick — a single slot made them evict each other and forced a full
// rebuild of both on every pass. Small LRU (insertion-ordered Map).
const SNAPSHOT_CACHE_MAX = 6;
const snapshotCache = new Map<string, DerivedSnapshot>();

function filtersKey(f: FilterSets): string {
  return [f.status, f.classification, f.occupancy, f.technician, f.tags].map((a) => a.join("")).join("");
}

function level1(input: SnapshotInput): ParseCache {
  const key = `${input.dataVersion}|${input.unitsVersion}`;
  if (parseCache?.key === key) return parseCache;

  const parsed = parseAll(input.workOrders);
  const unitIndex = makeUnitIndex(input.units);
  const byUnit = new Map<string, ParsedWorkOrder[]>();
  for (const wo of parsed) {
    const unit = wo.unitNumber.trim().length > 0 ? wo.unitNumber : "Unassigned Unit";
    const list = byUnit.get(unit);
    if (list) list.push(wo);
    else byUnit.set(unit, [wo]);
  }
  parseCache = { key, parsed, unitIndex, byUnit };
  return parseCache;
}

export function buildSnapshot(input: SnapshotInput): DerivedSnapshot {
  // The snapshot depends on the calendar day (aging, week windows), not the
  // millisecond — key on the day so the memo survives within a session but a
  // date rollover recomputes.
  const dayKey = Math.floor(input.nowMs / (24 * 60 * 60 * 1000));
  const key = [
    input.dataVersion,
    input.unitsVersion,
    input.mode,
    input.sortOption,
    input.search.trim().toLowerCase(),
    filtersKey(input.openFilters),
    filtersKey(input.closedFilters),
    input.signalFilter,
    dayKey,
  ].join("|");
  const cached = snapshotCache.get(key);
  if (cached) {
    // Refresh LRU recency so the two live tabs both stay resident.
    snapshotCache.delete(key);
    snapshotCache.set(key, cached);
    return cached;
  }

  const { parsed, unitIndex, byUnit } = level1(input);
  const search = input.search.trim().toLowerCase();
  const nowMs = input.nowMs;

  // The open/closed filtered sets exist regardless of the current mode — the
  // analytics overlays and score cards read them from any tab (Swift kept both
  // alive the same way).
  const open = filterWorkOrders({
    workOrders: parsed,
    mode: "open",
    search,
    filters: input.openFilters,
    signalFilter: input.signalFilter,
    unitIndex,
  });
  const closed = filterWorkOrders({
    workOrders: parsed,
    mode: "closed",
    search,
    filters: input.closedFilters,
    signalFilter: "all",
    unitIndex,
  });

  // Make-ready and hot-spots have no facet UI: search-only membership.
  const makeReadySet = parsed.filter((wo) => matchesDisplayMode(wo, "makeReady") && matchesSearch(wo, search));
  const hotSpotSet = parsed.filter((wo) => matchesDisplayMode(wo, "hotSpots") && matchesSearch(wo, search));
  const allNonMakeReady = parsed.filter((wo) => !wo.isMakeReady);

  const openGroups = buildOpenGroups({ workOrders: open.filtered, option: input.sortOption, unitIndex, nowMs });
  const closedRows = buildClosedRows({ workOrders: closed.filtered, option: input.sortOption, unitIndex, nowMs });
  const makeReadyGroups = buildMakeReadyGroups({ workOrders: makeReadySet, unitIndex, nowMs });
  const hotSpotRows = buildHotSpotRows({ workOrders: hotSpotSet, unitIndex, nowMs });

  const weeklySummary = buildWeeklyTechnicianSummary(closed.filtered, nowMs);
  const monthlySummary = buildMonthlyTechnicianSummary(closed.filtered, nowMs);
  const monthlyClassification = buildMonthlyClassification({ workOrders: allNonMakeReady, unitIndex, nowMs });
  const sameWeek = buildSameWeekTimeline(closed.filtered, nowMs);
  const daysToClose = buildDaysToCloseDistribution(closed.filtered);
  const callbacks = buildCallbackAnalytics({ workOrders: allNonMakeReady, nowMs });

  const visible =
    input.mode === "open"
      ? open.filtered
      : input.mode === "closed"
        ? closed.filtered
        : input.mode === "makeReady"
          ? makeReadySet
          : hotSpotSet;

  const scoreCards = buildScoreCards({
    mode: input.mode,
    visible,
    openFiltered: open.filtered,
    closedFiltered: closed.filtered,
    allNonMakeReady,
    makeReadyGroups,
    hotSpotRows,
    weeklySummary,
    nowMs,
  });

  const snapshot: DerivedSnapshot = {
    mode: input.mode,
    visible,
    panel: input.mode === "closed" ? closed.panel : open.panel,
    scoreCards,
    openGroups,
    closedRows,
    makeReadyGroups,
    makeReadyQuickCounts: quickFilterCounts(makeReadyGroups),
    hotSpotRows,
    weeklySummary,
    monthlySummary,
    monthlyClassification,
    sameWeek,
    daysToClose,
    callbacks,
    byUnit,
    unitIndex,
  };
  snapshotCache.set(key, snapshot);
  // Evict the oldest once over capacity (insertion order = LRU order).
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest === undefined) break;
    snapshotCache.delete(oldest);
  }
  return snapshot;
}

/** Test hook: clear both cache levels. */
export function resetSnapshotCaches(): void {
  parseCache = null;
  snapshotCache.clear();
}

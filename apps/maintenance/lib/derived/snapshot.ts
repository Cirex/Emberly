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
import { buildClosedInsights, type ClosedInsights } from "./closed-insights";
import { buildScoreCards, type ScoreCard } from "./score-cards";
import type { WorkOrderSortOption } from "./sort";
import { buildMonthlyTechnicianSummary, buildWeeklyTechnicianSummary, type TechnicianSummary } from "./technician-summary";
import { WORK_ORDER_CLOSED_STATUSES } from "@emberly/core";
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

/** React Native's dev flag, absent outside the app (tests, node tooling). */
const DEV = typeof __DEV__ !== "undefined" && __DEV__;

export interface SnapshotInput {
  /** Active UI language — part of the cache key because score-card titles are
   *  composed through i18next at build time. Defaults to "en" (tests). */
  language?: string;
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
  /** Aggregates for the Closed board's insights sheet. */
  closedInsights: ClosedInsights;
  /** Same-unit index for "Related Work Orders" on the detail screen. */
  byUnit: Map<string, ParsedWorkOrder[]>;
  unitIndex: UnitIndex;
  /**
   * False while this was built from the open-only launch parse. Anything that
   * counts CLOSED work is short until the wide parse lands, so a screen showing
   * those must say it is still counting rather than report a confident zero.
   */
  complete: boolean;
}

/**
 * The level-1 result: the mirror parsed once, plus the indexes every consumer
 * would otherwise rebuild. Exported because it is NOT private to the snapshot —
 * My Day needs the same parsed rows, and parsing 4,000 work orders a second time
 * (measured at 154ms on a desktop, worse on a phone) is the single most
 * expensive thing this app can do on a tab change.
 */
export interface ParsedMirror {
  key: string;
  parsed: ParsedWorkOrder[];
  unitIndex: UnitIndex;
  byUnit: Map<string, ParsedWorkOrder[]>;
  byId: Map<string, ParsedWorkOrder>;
  /**
   * False while this holds only the OPEN rows. Screens that can show something
   * useful from open work alone (My Day, the open board) are already right;
   * anything counting closed work must wait or say it is still counting.
   */
  complete: boolean;
}

export interface ParseMirrorInput {
  workOrders: WorkOrder[];
  units: ResmanUnit[];
  dataVersion: number;
  unitsVersion: number;
}

/**
 * How much of the mirror to parse.
 *
 * Measured on device: parsing all 4,074 rows takes 706ms, and it is 72% of My
 * Day's 982ms first mount. But My Day only ever shows OPEN work — 387 rows,
 * under a tenth of the corpus — so nine tenths of that second buys the launch
 * screen nothing. "open" parses just those; "all" does the rest afterwards.
 */
export type ParseScope = "open" | "all";

const CLOSED_STATUSES = new Set(WORK_ORDER_CLOSED_STATUSES.map((s) => s.toLowerCase()));

/**
 * Rows that could belong on an open board, tested on the RAW row so the filter
 * costs nothing. Deliberately a superset: anything with an unrecognised status
 * stays in, because a row nobody can classify should still be visible.
 */
function openRowsOf(rows: WorkOrder[]): WorkOrder[] {
  return rows.filter((row) => !CLOSED_STATUSES.has((row.status ?? "").trim().toLowerCase()));
}

/** One slot per scope: the staged parse holds both at once by design. */
const parseCaches = new Map<ParseScope, ParsedMirror>();

/** The identity of a data generation, shared by both scopes. */
export function mirrorKeyOf(input: ParseMirrorInput): string {
  return `${input.dataVersion}|${input.unitsVersion}`;
}

/** Whether the FULL parse for this generation is already done and cached. */
export function hasCompleteMirror(key: string): boolean {
  return parseCaches.get("all")?.key === key;
}

/**
 * Parse the mirror, or return the cached parse when nothing has changed.
 *
 * Keyed on (dataVersion, unitsVersion) — the two counters that move only when
 * the data actually differs — so every screen calling this within a data
 * generation shares ONE parse and one set of row objects. Callers must derive
 * `unitsVersion` from the shared helper in lib/hooks/use-parsed-mirror, or two
 * numbering schemes would produce different keys for the same array and evict
 * each other on every render.
 */
export function parseMirror(input: ParseMirrorInput, scope: ParseScope = "all"): ParsedMirror {
  const key = mirrorKeyOf(input);
  const cached = parseCaches.get(scope);
  if (cached?.key === key) return cached;
  // Never hand back the narrow parse when the full one is already done.
  if (scope === "open" && hasCompleteMirror(key)) return parseCaches.get("all")!;

  // `typeof` guarded: __DEV__ is a React Native global, and this module is
  // imported by the derived-engine tests, which run in plain bun.
  const startedAt = DEV ? Date.now() : 0;
  const rows = scope === "open" ? openRowsOf(input.workOrders) : input.workOrders;
  const parsed = parseAll(rows);
  const unitIndex = makeUnitIndex(input.units);
  const byUnit = new Map<string, ParsedWorkOrder[]>();
  const byId = new Map<string, ParsedWorkOrder>();
  for (const wo of parsed) {
    const unit = wo.unitNumber.trim().length > 0 ? wo.unitNumber : "Unassigned Unit";
    const list = byUnit.get(unit);
    if (list) list.push(wo);
    else byUnit.set(unit, [wo]);
    byId.set(wo.id, wo);
  }
  const mirror: ParsedMirror = { key, parsed, unitIndex, byUnit, byId, complete: scope === "all" };
  parseCaches.set(scope, mirror);
  if (DEV) {
    console.log(`[perf] parseMirror(${scope}) ${Date.now() - startedAt}ms for ${parsed.length} rows`);
  }
  return mirror;
}
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

export function buildSnapshot(input: SnapshotInput, mirror?: ParsedMirror): DerivedSnapshot {
  // The snapshot depends on the calendar day (aging, week windows), not the
  // millisecond — key on the day so the memo survives within a session but a
  // date rollover recomputes.
  const dayKey = Math.floor(input.nowMs / (24 * 60 * 60 * 1000));
  const key = [
    input.language ?? "en",
    input.dataVersion,
    input.unitsVersion,
    input.mode,
    input.sortOption,
    input.search.trim().toLowerCase(),
    filtersKey(input.openFilters),
    filtersKey(input.closedFilters),
    input.signalFilter,
    dayKey,
    // Without this a snapshot built from the OPEN-only parse would be cached
    // under the same key as the full one, and the rest of the corpus would
    // never reach the screen.
    mirror && !mirror.complete ? "open" : "all",
  ].join("|");
  const cached = snapshotCache.get(key);
  if (cached) {
    // Refresh LRU recency so the two live tabs both stay resident.
    snapshotCache.delete(key);
    snapshotCache.set(key, cached);
    return cached;
  }

  const { parsed, unitIndex, byUnit } = mirror ?? parseMirror(input);
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
  const closedInsights = buildClosedInsights({ allNonMakeReady, closedFiltered: closed.filtered, nowMs });
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
    closedInsights,
    byUnit,
    unitIndex,
    complete: mirror ? mirror.complete : true,
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
  parseCaches.clear();
  snapshotCache.clear();
}

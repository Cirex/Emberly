import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { WorkOrderSortOption } from "@/lib/derived/sort";
import { axesOf, optionFor, reconcileForMode } from "@/lib/derived/sort-axes";
import { EMPTY_FILTERS, type DisplayMode, type FilterSets, type SignalFilter } from "@/lib/derived/types";
export type { SignalFilter };

/**
 * UI state for the Work Orders workspace — the port of WorkOrdersViewState.
 * Open and closed modes carry independent facet-filter sets (faithful to the
 * Swift split); make-ready and hot-spots have no facet UI. Only displayMode and
 * sortOption survive restarts; filters and search are momentary inputs.
 */

/**
 * The header dropdown's mode set: the derived engine's work-order modes plus
 * "preventive" — the Emberly PM board, which renders from the PM store
 * (lib/stores/pm.ts) rather than the work-order snapshot, so it deliberately
 * stays OUT of DisplayMode and the derived engine.
 */
export type WorkOrdersBoardMode = DisplayMode | "preventive";

export type AnalyticsOverlay =
  | null
  | "openMonthly"
  | "sameWeek"
  | "daysToClose"
  | "callbacks"
  | "technicianWeek"
  | "technicianMonth"
  | "closedInsights";

interface WorkOrdersViewState {
  displayMode: WorkOrdersBoardMode;
  sortOption: WorkOrderSortOption;
  /** Immediate input value (TextInput binds here). */
  search: string;
  /** Debounced value the derived engine consumes (150ms behind). */
  debouncedSearch: string;
  openFilters: FilterSets;
  closedFilters: FilterSets;
  signalFilter: SignalFilter;
  expandedUnits: string[];
  showCompletedTurns: boolean;
  makeReadyQuickFilter: import("@/lib/derived/make-ready").MakeReadyQuickFilter;
  selectedHotSpotUnit: string | null;
  activeOverlay: AnalyticsOverlay;
  filterSheetOpen: boolean;

  setDisplayMode: (m: WorkOrdersBoardMode) => void;
  setSortOption: (s: WorkOrderSortOption) => void;
  setSearch: (q: string) => void;
  setFilters: (mode: "open" | "closed", f: FilterSets) => void;
  clearFilters: () => void;
  setSignalFilter: (v: SignalFilter) => void;
  toggleUnitExpanded: (unit: string) => void;
  setShowCompletedTurns: (v: boolean) => void;
  setMakeReadyQuickFilter: (f: import("@/lib/derived/make-ready").MakeReadyQuickFilter) => void;
  setSelectedHotSpotUnit: (u: string | null) => void;
  setActiveOverlay: (o: AnalyticsOverlay) => void;
  setFilterSheetOpen: (v: boolean) => void;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useWorkOrdersView = create<WorkOrdersViewState>()(
  persist(
    (set, get) => ({
      displayMode: "open",
      sortOption: "dateReportedDescending",
      search: "",
      debouncedSearch: "",
      openFilters: EMPTY_FILTERS,
      closedFilters: EMPTY_FILTERS,
      signalFilter: "all",
      expandedUnits: [],
      showCompletedTurns: false,
      makeReadyQuickFilter: "all",
      selectedHotSpotUnit: null,
      activeOverlay: null,
      filterSheetOpen: false,

      setDisplayMode: (displayMode) => {
        // Each board still opens on its natural FIELD — completed-date for
        // closed, reported-date otherwise, mirroring the Swift behaviour — but
        // the DIRECTION the technician chose is carried across.
        //
        // The old code hard-reset both. That made sense when the two were fused
        // into one pill; now that direction is its own control, silently
        // flipping it back on a tab change is just losing the user's input.
        const field = displayMode === "closed" ? "dateCompleted" : "dateReported";
        // `preventive` is a board mode with no sortable list of its own, so it
        // reconciles against the open vocabulary.
        const sortMode: DisplayMode = displayMode === "closed" ? "closed" : "open";
        const sortOption: WorkOrderSortOption = reconcileForMode(
          optionFor(field, axesOf(get().sortOption).direction),
          sortMode,
        );
        set({ displayMode, sortOption, selectedHotSpotUnit: null });
      },
      setSortOption: (sortOption) => set({ sortOption }),
      setSearch: (search) => {
        set({ search });
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          // Store may have moved on; only commit the latest input.
          if (get().search === search) set({ debouncedSearch: search });
        }, 150);
      },
      setFilters: (mode, f) => set(mode === "open" ? { openFilters: f } : { closedFilters: f }),
      clearFilters: () =>
        set((s) =>
          s.displayMode === "closed"
            ? { closedFilters: EMPTY_FILTERS, signalFilter: "all" }
            : { openFilters: EMPTY_FILTERS, signalFilter: "all" },
        ),
      setSignalFilter: (signalFilter) => set({ signalFilter }),
      toggleUnitExpanded: (unit) =>
        set((s) => ({
          expandedUnits: s.expandedUnits.includes(unit)
            ? s.expandedUnits.filter((u) => u !== unit)
            : [...s.expandedUnits, unit],
        })),
      setShowCompletedTurns: (showCompletedTurns) => set({ showCompletedTurns }),
      setMakeReadyQuickFilter: (makeReadyQuickFilter) => set({ makeReadyQuickFilter }),
      setSelectedHotSpotUnit: (selectedHotSpotUnit) => set({ selectedHotSpotUnit }),
      setActiveOverlay: (activeOverlay) => set({ activeOverlay }),
      setFilterSheetOpen: (filterSheetOpen) => set({ filterSheetOpen }),
    }),
    {
      name: "emberly-maintenance-wo-view",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ displayMode: s.displayMode, sortOption: s.sortOption }),
    },
  ),
);

/** Count of active facet selections for the current mode (the Filters chip badge).
 *  The signal filter lives in the sheet too now, so it counts as one facet. */
export function activeFilterCount(s: {
  displayMode: WorkOrdersBoardMode;
  openFilters: FilterSets;
  closedFilters: FilterSets;
  signalFilter: SignalFilter;
}): number {
  if (s.displayMode === "makeReady" || s.displayMode === "hotSpots" || s.displayMode === "preventive") {
    return 0;
  }
  const f = s.displayMode === "closed" ? s.closedFilters : s.openFilters;
  const signal = s.displayMode === "open" && s.signalFilter !== "all" ? 1 : 0;
  return f.status.length + f.classification.length + f.occupancy.length + f.technician.length + f.tags.length + signal;
}

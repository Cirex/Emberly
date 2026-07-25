import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
import { rowsEqual } from "@/lib/stores/row-compare";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  type LeaseStatusFilter,
  type ResmanConfig,
  type ResmanUnit,
  listUnits,
} from "@/lib/api/units";
import { unitMatchesSearch } from "@emberly/core";

/**
 * What the chips select. "Occupied"/"Vacant" are occupancy statuses; the other
 * two are lease statuses, because ResMan files both under the one occupancy
 * value "Notice" and only the lease status tells an eviction from a notice.
 */
export type UnitFilter = "all" | "Occupied" | "Vacant" | LeaseStatusFilter;

const LEASE_STATUS_FILTERS: readonly UnitFilter[] = ["Notice to Vacate", "Under Eviction"];

interface UnitsState {
  units: ResmanUnit[];
  total: number;
  filter: UnitFilter;
  search: string;
  loading: boolean;
  error?: string;
  /** Full unfiltered set for the Property Map (paginated past the 200 cap). */
  allUnits: ResmanUnit[];
  loadingAll: boolean;
  setFilter: (f: UnitFilter) => void;
  setSearch: (q: string) => void;
  load: (config: ResmanConfig) => Promise<void>;
  loadAll: (config: ResmanConfig) => Promise<void>;
  /**
   * Silent background sync: refreshes both the full set and the current
   * filter page without touching the loading flags, and skips the state
   * write (and its re-render) when nothing on the server changed.
   */
  refresh: (config: ResmanConfig) => Promise<void>;
  /** Client-side search over the loaded page (the ResMan API has no unit text search). */
  visible: () => ResmanUnit[];
}

const PAGE = 200;

/** Fetch every page of the unfiltered set. */
async function fetchAll(config: ResmanConfig): Promise<ResmanUnit[]> {
  const acc: ResmanUnit[] = [];
  let offset = 0;
  for (;;) {
    const res = await listUnits({ limit: PAGE, offset }, config);
    acc.push(...res.data);
    if (!res.pagination.hasMore) break;
    offset += PAGE;
    if (offset > 20_000) break; // safety valve
  }
  return acc;
}

function filterParams(filter: UnitFilter) {
  return {
    limit: PAGE,
    // The chip picks one column or the other, never both.
    occupancy_status: filter === "Occupied" || filter === "Vacant" ? filter : undefined,
    lease_status: LEASE_STATUS_FILTERS.includes(filter) ? (filter as LeaseStatusFilter) : undefined,
  };
}

let refreshing = false;

export const useUnits = create<UnitsState>()(
  persist(
    (set, get) => ({
      units: [],
      total: 0,
      filter: "all",
      search: "",
      loading: false,
      allUnits: [],
      loadingAll: false,

      setFilter: (filter) => set({ filter }),
      setSearch: (search) => set({ search }),

      loadAll: async (config) => {
        if (get().loadingAll) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loadingAll: get().allUnits.length === 0, error: undefined });
        try {
          const acc = await fetchAll(config);
          set({ allUnits: acc, loadingAll: false });
        } catch (err) {
          set({ loadingAll: false, error: err instanceof Error ? err.message : "Failed to load units" });
        }
      },

      load: async (config) => {
        set({ loading: get().units.length === 0, error: undefined });
        try {
          const res = await listUnits(filterParams(get().filter), config);
          set({ units: res.data, total: res.pagination.count, loading: false });
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load units" });
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const { filter } = get();
          const [all, page] = await Promise.all([fetchAll(config), listUnits(filterParams(filter), config)]);
          // The state only moves when the data did — a quiet 60s poll must not
          // re-render four screens just to confirm nothing happened.
          const prev = get();
          if (!rowsEqual(all, prev.allUnits)) set({ allUnits: all });
          if (
            prev.filter === filter &&
            (!rowsEqual(page.data, prev.units) || page.pagination.count !== prev.total)
          ) {
            set({ units: page.data, total: page.pagination.count });
          }
          reportSyncSucceeded("units");
        } catch {
          // Background sync failing is not an error state the UI should enter —
          // the cached data stands, and the next tick retries.
          reportSyncFailed("units");
        } finally {
          refreshing = false;
        }
      },

      visible: () => {
        const { units, allUnits, search } = get();
        if (!search.trim()) return units;
        // Search the FULL cached set, not just the current page. The ResMan API
        // has no text search, so a paged `units` (200 rows) would silently hide
        // every unit past the first page — "king" would miss the Kingsgate block.
        const source = allUnits.length > 0 ? allUnits : units;
        return source.filter((u) => unitMatchesSearch(u, search));
      },
    }),
    {
      name: "emberly-maintenance-units",
      storage: persistedStorage(),
      // Only the data survives restarts. Flags are per-session, and search is
      // a momentary input, not a preference.
      partialize: (s) => ({ units: s.units, total: s.total, filter: s.filter, allUnits: s.allUnits }),
    },
  ),
);

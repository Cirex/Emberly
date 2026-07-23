import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  type LeaseStatusFilter,
  type ResmanConfig,
  type ResmanUnit,
  listGuestBannedUnits,
  listUnits,
} from "@/lib/api/units";
import { unitMatchesSearch } from "@emberly/core";

/**
 * What the chips select. "Occupied"/"Vacant" are occupancy statuses; the next
 * two are lease statuses, because ResMan files both under the one occupancy
 * value "Notice" and only the lease status tells an eviction from a notice.
 * "No Guests" is first-party: units whose guest visits an admin disabled
 * (unit-level or resident-level ban), filtered against `bannedUnits`.
 */
export type UnitFilter = "all" | "Occupied" | "Vacant" | LeaseStatusFilter | "No Guests";

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
  /** Unit numbers with guest visits disabled — backs the "No Guests" chip. */
  bannedUnits: string[];
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

/** The chips' meaning, applied client-side: same columns the server params filter on. */
function matchesFilter(u: ResmanUnit, filter: UnitFilter, banned: ReadonlySet<string>): boolean {
  if (filter === "all") return true;
  if (filter === "Occupied" || filter === "Vacant") return u.occupancy_status === filter;
  if (filter === "No Guests") return banned.has(u.number.trim());
  return u.lease_status === filter;
}

/** Guest-ban fetch is additive: on failure the last known set stands, and the
 *  chip degrades to stale rather than the whole list erroring. */
async function fetchBannedUnits(config: ResmanConfig, fallback: string[]): Promise<string[]> {
  try {
    return await listGuestBannedUnits(config);
  } catch {
    return fallback;
  }
}

/**
 * The rows a given view resolves to — pure, so the screen can `useMemo` it and
 * recompute only when its inputs actually change rather than on every render.
 * `store.visible()` delegates here for callers that want the current snapshot.
 */
export function computeVisibleUnits(input: {
  units: ResmanUnit[];
  allUnits: ResmanUnit[];
  search: string;
  filter: UnitFilter;
  bannedUnits: string[];
}): ResmanUnit[] {
  const { units, allUnits, search, filter, bannedUnits } = input;
  const banned = new Set(bannedUnits);
  // The FULL cached set is the source whenever it's loaded. The ResMan API pages
  // at 200 rows, so the server-paged `units` silently truncates any view past
  // the first page — "All" showed 200 of 878. The chip filters re-apply
  // client-side on the columns the rows already carry; the paged fetch remains
  // only as a first-paint fallback before loadAll lands.
  if (!search.trim()) {
    // "No Guests" only exists client-side, so it filters whichever set is
    // loaded rather than ever showing the unfiltered fallback page.
    if (allUnits.length === 0) {
      return filter === "No Guests" ? units.filter((u) => matchesFilter(u, filter, banned)) : units;
    }
    return allUnits.filter((u) => matchesFilter(u, filter, banned));
  }
  // Search scans the whole property regardless of the active chip — the ResMan
  // API has no text search, so "king" must not miss the Kingsgate block just
  // because it's on a later page or another chip.
  const source = allUnits.length > 0 ? allUnits : units;
  return source.filter((u) => unitMatchesSearch(u, search));
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
      bannedUnits: [],

      setFilter: (filter) => set({ filter }),
      setSearch: (search) => set({ search }),

      loadAll: async (config) => {
        if (get().loadingAll) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loadingAll: get().allUnits.length === 0, error: undefined });
        try {
          const [acc, banned] = await Promise.all([
            fetchAll(config),
            fetchBannedUnits(config, get().bannedUnits),
          ]);
          set({ allUnits: acc, bannedUnits: banned, loadingAll: false });
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
          const [all, page, banned] = await Promise.all([
            fetchAll(config),
            listUnits(filterParams(filter), config),
            fetchBannedUnits(config, get().bannedUnits),
          ]);
          // The state only moves when the data did — a quiet 60s poll must not
          // re-render four screens just to confirm nothing happened.
          const prev = get();
          if (JSON.stringify(all) !== JSON.stringify(prev.allUnits)) set({ allUnits: all });
          if (JSON.stringify(banned) !== JSON.stringify(prev.bannedUnits)) set({ bannedUnits: banned });
          if (
            prev.filter === filter &&
            (JSON.stringify(page.data) !== JSON.stringify(prev.units) || page.pagination.count !== prev.total)
          ) {
            set({ units: page.data, total: page.pagination.count });
          }
        } catch {
          // Background sync failing is not an error state the UI should enter —
          // the cached data stands, and the next tick retries.
        } finally {
          refreshing = false;
        }
      },

      visible: () => computeVisibleUnits(get()),
    }),
    {
      name: "emberly-security-units",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data survives restarts. Flags are per-session, and search is
      // a momentary input, not a preference.
      partialize: (s) => ({
        units: s.units,
        total: s.total,
        filter: s.filter,
        allUnits: s.allUnits,
        bannedUnits: s.bannedUnits,
      }),
    },
  ),
);

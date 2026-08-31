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
  /**
   * Newest server `updated_at` this device has absorbed. "" means no cursor
   * yet (fresh install, or a cache persisted before delta sync existed) and
   * forces one full read to establish it.
   */
  deltaCursor: string;
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

/** Newest server `updated_at` across `rows`, or `fallback` when none is newer. */
function maxUpdatedAt(rows: readonly ResmanUnit[], fallback: string): string {
  let max = fallback;
  for (const row of rows) {
    const stamp = row.updated_at ?? "";
    // ISO-8601 UTC strings from PostgREST sort lexicographically.
    if (stamp > max) max = stamp;
  }
  return max;
}

/** Page just the units that changed since `since`. */
async function fetchSince(config: ResmanConfig, since: string): Promise<ResmanUnit[]> {
  const acc: ResmanUnit[] = [];
  let offset = 0;
  for (;;) {
    const res = await listUnits({ limit: PAGE, offset, updatedSince: since }, config);
    acc.push(...res.data);
    if (!res.pagination.hasMore) break;
    offset += PAGE;
    if (offset > 20_000) break; // safety valve
  }
  return acc;
}

/**
 * The server's total row count, from a one-row request.
 *
 * This is how DELETIONS are caught. A delta read only ever reports rows that
 * still exist, so a unit removed from ResMan (and swept by the sync's
 * delete-missing pass) would otherwise sit on the device forever. Comparing
 * the count is exact and costs one tiny request.
 */
async function fetchTotalCount(config: ResmanConfig): Promise<number> {
  const res = await listUnits({ limit: 1 }, config);
  return res.pagination.count;
}

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
      deltaCursor: "",

      setFilter: (filter) => set({ filter }),
      setSearch: (search) => set({ search }),

      loadAll: async (config) => {
        if (get().loadingAll) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loadingAll: get().allUnits.length === 0, error: undefined });
        try {
          const acc = await fetchAll(config);
          set({ allUnits: acc, loadingAll: false, deltaCursor: maxUpdatedAt(acc, "") });
        } catch (err) {
          set({
            loadingAll: false,
            error: err instanceof Error ? err.message : "Failed to load units",
          });
        }
      },

      load: async (config) => {
        set({ loading: get().units.length === 0, error: undefined });
        try {
          const res = await listUnits(filterParams(get().filter), config);
          set({ units: res.data, total: res.pagination.count, loading: false });
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load units",
          });
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const { filter } = get();
          const cursor = get().deltaCursor;

          // The roster is ~900 units of ~45 columns and the sync worker only
          // rewrites it hourly, so re-downloading it on every tick was the
          // app's largest recurring transfer. Ask for what MOVED instead, and
          // page the current filter alongside it.
          const [changed, total, page] = await Promise.all([
            cursor === "" ? fetchAll(config) : fetchSince(config, cursor),
            cursor === "" ? Promise.resolve(-1) : fetchTotalCount(config),
            listUnits(filterParams(filter), config),
          ]);

          const prev = get();
          if (cursor === "") {
            // No cursor yet — this read IS the full set, and establishes it.
            if (!rowsEqual(changed, prev.allUnits)) set({ allUnits: changed });
            set({ deltaCursor: maxUpdatedAt(changed, "") });
          } else {
            const byId = new Map(prev.allUnits.map((row) => [row.resman_unit_id, row]));
            for (const row of changed) byId.set(row.resman_unit_id, row);
            if (byId.size !== total) {
              // Row count disagrees with the server: a unit was deleted (or an
              // earlier delta was missed). Only a full read can tell which, and
              // guessing would leave a phantom unit on the map.
              const all = await fetchAll(config);
              if (!rowsEqual(all, prev.allUnits)) set({ allUnits: all });
              set({ deltaCursor: maxUpdatedAt(all, "") });
            } else if (changed.length > 0) {
              set({
                allUnits: [...byId.values()],
                deltaCursor: maxUpdatedAt(changed, cursor),
              });
            }
            // changed.length === 0 and the count agrees: nothing moved, so no
            // state write at all — that silence is the point of the delta.
          }

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
      partialize: (s) => ({
        units: s.units,
        total: s.total,
        filter: s.filter,
        allUnits: s.allUnits,
        // Persisted with the rows it describes: a cursor without its cache (or
        // a cache without its cursor) would silently skip the units that moved
        // in between. A cache restored from before delta sync has no cursor,
        // reads as "", and takes the full-read path once.
        deltaCursor: s.deltaCursor,
      }),
    },
  ),
);

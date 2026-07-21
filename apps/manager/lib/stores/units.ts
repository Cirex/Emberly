import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import { listUnits, type ResmanConfig, type ResmanUnit } from "@/lib/api/units";
import { registerSync } from "@/lib/sync-registry";

/**
 * The ResMan units mirror, manager cut: one full unfiltered set (`allUnits`,
 * paginated past the API's 200-row cap) that every feature reads from —
 * occupancy and classification for the map, balances for delinquency, lease
 * and move dates for leasing. The maintenance app's per-filter page state was
 * deliberately not ported; features derive their own slices from `allUnits`.
 */
interface UnitsState {
  /** Full unfiltered set, cached on disk across launches. */
  allUnits: ResmanUnit[];
  loadingAll: boolean;
  error?: string;
  /** Epoch ms of the last successful load/refresh; 0 = never this install. */
  refreshedAt: number;
  loadAll: (config: ResmanConfig) => Promise<void>;
  /**
   * Silent background sync: refreshes the full set without touching the
   * loading flag, and skips the state write (and its re-render) when nothing
   * on the server changed.
   */
  refresh: (config: ResmanConfig) => Promise<void>;
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

let refreshing = false;

export const useUnits = create<UnitsState>()(
  persist(
    (set, get) => ({
      allUnits: [],
      loadingAll: false,
      refreshedAt: 0,

      loadAll: async (config) => {
        if (get().loadingAll) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loadingAll: get().allUnits.length === 0, error: undefined });
        try {
          const acc = await fetchAll(config);
          set({ allUnits: acc, loadingAll: false, refreshedAt: Date.now() });
          reportSyncSucceeded("units");
        } catch (err) {
          set({ loadingAll: false, error: err instanceof Error ? err.message : "Failed to load units" });
          reportSyncFailed("units");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const all = await fetchAll(config);
          // The state only moves when the data did — a quiet 60s poll must not
          // re-render every screen just to confirm nothing happened.
          if (JSON.stringify(all) !== JSON.stringify(get().allUnits)) set({ allUnits: all });
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("units");
        } catch {
          // Background sync failing is not an error state the UI should enter —
          // the cached data stands, and the next tick retries.
          reportSyncFailed("units");
        } finally {
          refreshing = false;
        }
      },
    }),
    {
      name: "emberly-manager-units",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data survives restarts; flags are per-session.
      partialize: (s) => ({ allUnits: s.allUnits }),
    },
  ),
);

// Self-register with the sync tick (see lib/sync-registry.ts). First run on a
// cold cache takes the loadAll spinner path so screens have something honest
// to render; every later tick is a silent refresh.
registerSync("units", async (config) => {
  const s = useUnits.getState();
  if (s.allUnits.length === 0) await s.loadAll(config);
  else await s.refresh(config);
});

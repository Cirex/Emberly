import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import { listManagerLeases, type ManagerLease } from "@/lib/api/leases";
import { registerSync } from "@/lib/sync-registry";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The manager lease mirror: one chunky set (last 24 months + anything still
 * current, see GET /api/resman/manager/leases) that the Leasing boards and the
 * Today feed derive from on device. Same shape as the units store — full set
 * cached on disk, spinner only on a true first run, silent refresh behind the
 * cached rows otherwise.
 */
interface LeasesState {
  /** Full lease window, cached on disk across launches. */
  leases: ManagerLease[];
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful load/refresh; 0 = never this install. */
  refreshedAt: number;
  loadAll: (config: StaffConfig) => Promise<void>;
  /**
   * Silent background sync: refreshes without touching the loading flag and
   * skips the state write (and its re-render) when nothing changed.
   */
  refresh: (config: StaffConfig) => Promise<void>;
}

let refreshing = false;

export const useLeases = create<LeasesState>()(
  persist(
    (set, get) => ({
      leases: [],
      loading: false,
      refreshedAt: 0,

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loading: get().leases.length === 0, error: undefined });
        try {
          const leases = await listManagerLeases(config);
          set({ leases, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("leases");
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load leases" });
          reportSyncFailed("leases");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const leases = await listManagerLeases(config);
          // The state only moves when the data did — a quiet 60s poll must not
          // re-render both boards just to confirm nothing happened.
          if (JSON.stringify(leases) !== JSON.stringify(get().leases)) set({ leases });
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("leases");
        } catch {
          // Background sync failing is not an error state the UI should enter —
          // the cached data stands, and the next tick retries.
          reportSyncFailed("leases");
        } finally {
          refreshing = false;
        }
      },
    }),
    {
      name: "emberly-manager-leases",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data survives restarts; flags are per-session.
      partialize: (s) => ({ leases: s.leases }),
    },
  ),
);

// Self-register with the sync tick (see lib/sync-registry.ts). First run on a
// cold cache takes the loadAll spinner path so screens have something honest
// to render; every later tick is a silent refresh.
registerSync("leases", async (config) => {
  const s = useLeases.getState();
  if (s.leases.length === 0) await s.loadAll(config);
  else await s.refresh(config);
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import { fetchAllWorkOrders, type WorkOrder } from "@/lib/api/work-orders";
import type { StaffConfig } from "@/lib/stores/config";
import { registerSync } from "@/lib/sync-registry";

/**
 * The ResMan work-order mirror, manager cut: one full unfiltered set cached on
 * disk that the Work tab bands three ways (open · make ready · closed) and the
 * Today board reads its make-ready snapshot from. Read-only — closing and
 * editing tickets stays in the maintenance app.
 */
interface WorkOrdersState {
  /** Full unfiltered set, cached on disk across launches. */
  workOrders: WorkOrder[];
  /** True only during a cold-cache first load; refreshes are silent. */
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful load/refresh; 0 = never this install. */
  refreshedAt: number;
  loadAll: (config: StaffConfig) => Promise<void>;
  /**
   * Silent background sync: refreshes the full set without touching the
   * loading flag, and skips the state write (and its re-render) when nothing
   * on the server changed.
   */
  refresh: (config: StaffConfig) => Promise<void>;
}

let refreshing = false;

export const useWorkOrders = create<WorkOrdersState>()(
  persist(
    (set, get) => ({
      workOrders: [],
      loading: false,
      refreshedAt: 0,

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loading: get().workOrders.length === 0, error: undefined });
        try {
          const rows = await fetchAllWorkOrders(config);
          set({ workOrders: rows, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("workOrders");
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load work orders",
          });
          reportSyncFailed("workOrders");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const rows = await fetchAllWorkOrders(config);
          // The state only moves when the data did — a quiet 60s poll must not
          // re-parse 4k rows and re-render the board to confirm nothing happened.
          if (JSON.stringify(rows) !== JSON.stringify(get().workOrders)) set({ workOrders: rows });
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("workOrders");
        } catch {
          // Background sync failing is not an error state the UI should enter —
          // the cached data stands, and the next tick retries.
          reportSyncFailed("workOrders");
        } finally {
          refreshing = false;
        }
      },
    }),
    {
      name: "emberly-manager-work-orders",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data survives restarts; flags are per-session.
      partialize: (s) => ({ workOrders: s.workOrders }),
    },
  ),
);

// Self-register with the sync tick (see lib/sync-registry.ts). First run on a
// cold cache takes the loadAll spinner path so screens have something honest
// to render; every later tick is a silent refresh.
registerSync("workOrders", async (config) => {
  const s = useWorkOrders.getState();
  if (s.workOrders.length === 0) await s.loadAll(config);
  else await s.refresh(config);
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import { fetchSnapshots, type Snapshot } from "@/lib/api/snapshots";
import { registerSync } from "@/lib/sync-registry";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The snapshots store: the full 24-month daily property_snapshots window,
 * cached on disk. ~730 small numeric rows — cheap to persist, and persistence
 * is what lets the Trends sheet (and the Today sparklines) paint instantly on
 * a cold open. Range chips (12m / 3m / 30d) slice this one array locally; no
 * per-range refetch.
 */
interface SnapshotsState {
  /** One row per day, oldest first, exactly as served. */
  snapshots: Snapshot[];
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful load/refresh; 0 = never this install. */
  refreshedAt: number;
  loadAll: (config: StaffConfig) => Promise<void>;
  /** Silent background sync — no spinner, no write when nothing changed. */
  refresh: (config: StaffConfig) => Promise<void>;
}

let refreshing = false;

export const useSnapshots = create<SnapshotsState>()(
  persist(
    (set, get) => ({
      snapshots: [],
      loading: false,
      refreshedAt: 0,

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run.
        set({ loading: get().snapshots.length === 0, error: undefined });
        try {
          const snapshots = await fetchSnapshots(config);
          set({ snapshots, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("snapshots");
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load snapshots",
          });
          reportSyncFailed("snapshots");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const snapshots = await fetchSnapshots(config);
          // A quiet 60s poll must not re-render the charts just to confirm
          // nothing moved — the table gains at most one row per day.
          if (JSON.stringify(snapshots) !== JSON.stringify(get().snapshots)) {
            set({ snapshots });
          }
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("snapshots");
        } catch {
          // The cached window stands; the next tick retries.
          reportSyncFailed("snapshots");
        } finally {
          refreshing = false;
        }
      },
    }),
    {
      name: "emberly-manager-snapshots",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ snapshots: s.snapshots, refreshedAt: s.refreshedAt }),
    },
  ),
);

// Self-register with the sync tick (see lib/sync-registry.ts): cold cache takes
// the loadAll spinner path, every later tick is a silent refresh.
registerSync("snapshots", async (config) => {
  const s = useSnapshots.getState();
  if (s.snapshots.length === 0) await s.loadAll(config);
  else await s.refresh(config);
});

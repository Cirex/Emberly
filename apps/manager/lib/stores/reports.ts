import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import { fetchReports, type OwnerReport } from "@/lib/api/reports";
import { registerSync } from "@/lib/sync-registry";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The owner-reports store: the archive index (≤ 24 entries, newest first,
 * summaries included), cached on disk so the Today card and PAST REPORTS band
 * paint instantly on a cold open. A new entry appears at most once a month —
 * the 60s tick is overkill by design, and the no-change guard keeps it silent.
 */
interface ReportsState {
  /** Newest first, exactly as served. */
  reports: OwnerReport[];
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful load/refresh; 0 = never this install. */
  refreshedAt: number;
  loadAll: (config: StaffConfig) => Promise<void>;
  /** Silent background sync — no spinner, no write when nothing changed. */
  refresh: (config: StaffConfig) => Promise<void>;
}

let refreshing = false;

export const useReports = create<ReportsState>()(
  persist(
    (set, get) => ({
      reports: [],
      loading: false,
      refreshedAt: 0,

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run.
        set({ loading: get().reports.length === 0, error: undefined });
        try {
          const reports = await fetchReports(config);
          set({ reports, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("reports");
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load reports",
          });
          reportSyncFailed("reports");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const reports = await fetchReports(config);
          // Reports freeze at generation — the list changes once a month, so
          // a quiet tick must not re-render the Today board to confirm that.
          if (JSON.stringify(reports) !== JSON.stringify(get().reports)) {
            set({ reports });
          }
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("reports");
        } catch {
          // The cached archive stands; the next tick retries.
          reportSyncFailed("reports");
        } finally {
          refreshing = false;
        }
      },
    }),
    {
      name: "emberly-manager-reports",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ reports: s.reports, refreshedAt: s.refreshedAt }),
    },
  ),
);

// Self-register with the sync tick (see lib/sync-registry.ts): cold cache takes
// the loadAll spinner path, every later tick is a silent refresh.
registerSync("reports", async (config) => {
  const s = useReports.getState();
  if (s.reports.length === 0) await s.loadAll(config);
  else await s.refresh(config);
});

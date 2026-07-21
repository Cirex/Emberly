import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  fetchLeaseLedger,
  fetchLedgerSummary,
  type LeaseLedgerSummary,
  type LedgerEntry,
} from "@/lib/api/delinquency";
import type { StaffConfig } from "@/lib/stores/config";
import { registerSync } from "@/lib/sync-registry";

/**
 * The ResMan lease-ledger mirror, manager cut: one aggregate row per lease
 * (billed/collected/first-late/concessions/write-offs — the P&L feed), synced
 * on the shared tick and persisted; plus per-lease drill-in entries fetched
 * LAZILY when a tenant sheet opens and kept only in memory for the session —
 * 500 rows × many leases is exactly what should not sit in AsyncStorage.
 */
interface LedgerState {
  summaries: LeaseLedgerSummary[];
  /** Epoch ms of the last successful summary refresh; 0 = never. */
  refreshedAt: number;
  /** Per-lease drill-in cache, session-only (not persisted). */
  entriesByLease: Record<string, LedgerEntry[]>;
  /** Lease id currently fetching its drill-in, if any. */
  loadingLease: string | null;
  refreshSummaries: (config: StaffConfig) => Promise<void>;
  /** Fetch one lease's full ledger for the timeline; cached per session. */
  loadLease: (config: StaffConfig, leaseId: string) => Promise<void>;
}

let refreshing = false;

export const useLedger = create<LedgerState>()(
  persist(
    (set, get) => ({
      summaries: [],
      refreshedAt: 0,
      entriesByLease: {},
      loadingLease: null,

      refreshSummaries: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const summaries = await fetchLedgerSummary(config);
          // Quiet tick: skip the state write when the aggregate didn't move.
          if (JSON.stringify(summaries) !== JSON.stringify(get().summaries)) set({ summaries });
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("ledgerSummary");
        } catch {
          // Cached summaries stand; the next tick retries.
          reportSyncFailed("ledgerSummary");
        } finally {
          refreshing = false;
        }
      },

      loadLease: async (config, leaseId) => {
        if (get().entriesByLease[leaseId] || get().loadingLease === leaseId) return;
        set({ loadingLease: leaseId });
        try {
          const entries = await fetchLeaseLedger(config, leaseId);
          set({ entriesByLease: { ...get().entriesByLease, [leaseId]: entries } });
        } catch {
          // The sheet renders actions-only; reopening retries the fetch.
        } finally {
          if (get().loadingLease === leaseId) set({ loadingLease: null });
        }
      },
    }),
    {
      name: "emberly-manager-ledger",
      storage: createJSONStorage(() => AsyncStorage),
      // Summaries persist; the drill-in cache is deliberately session-only.
      partialize: (s) => ({ summaries: s.summaries, refreshedAt: s.refreshedAt }),
    },
  ),
);

// Summaries ride the shared sync tick like every other mirror.
registerSync("ledgerSummary", async (config) => {
  await useLedger.getState().refreshSummaries(config);
});

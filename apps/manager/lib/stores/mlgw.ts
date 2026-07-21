import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { capture, reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  fetchManagerMlgw,
  setMlgwReviewed,
  type ManagerMlgwPayload,
  type MlgwReview,
} from "@/lib/api/mlgw";
import { registerSync } from "@/lib/sync-registry";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The MLGW mirror for the Utilities board: the whole GET
 * /api/resman/manager/mlgw payload cached on disk, refreshed by the shared
 * sync tick (registerSync("mlgw")), plus the one write this feature owns —
 * the optimistic exception-reviewed toggle.
 */
interface MlgwState {
  data: ManagerMlgwPayload | null;
  /** True only during a cold-cache first load; refreshes are silent. */
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful load/refresh; 0 = never this install. */
  refreshedAt: number;
  load: (config: StaffConfig) => Promise<void>;
  refresh: (config: StaffConfig) => Promise<void>;
  /**
   * Toggle one exception's reviewed checkbox, optimistically: the local
   * reviews list flips immediately, the POST follows, and a failure reverts
   * to the pre-toggle list. Resolves true when the server accepted.
   */
  toggleReview: (
    config: StaffConfig,
    billId: string,
    kind: string,
    reviewed: boolean,
    accountNumber?: string,
  ) => Promise<boolean>;
}

/** A locally-minted review row standing in until the next sync echoes it. */
function optimisticReview(billId: string, kind: string, accountNumber?: string): MlgwReview {
  return {
    id: `local|${billId}|${kind}`,
    billId,
    accountNumber: accountNumber ?? "",
    exceptionKind: kind,
    reviewedAt: new Date().toISOString(),
  };
}

let refreshing = false;

export const useMlgw = create<MlgwState>()(
  persist(
    (set, get) => ({
      data: null,
      loading: false,
      refreshedAt: 0,

      load: async (config) => {
        if (get().loading) return;
        // Spinner only on a true cold cache — cached rows stay up otherwise.
        set({ loading: get().data === null, error: undefined });
        try {
          const data = await fetchManagerMlgw(config);
          set({ data, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("mlgw");
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load MLGW data",
          });
          reportSyncFailed("mlgw");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const data = await fetchManagerMlgw(config);
          // Only write state when the payload moved — a quiet 60s tick must
          // not re-render the board just to confirm nothing happened.
          if (JSON.stringify(data) !== JSON.stringify(get().data)) set({ data });
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("mlgw");
        } catch {
          // Background sync failing is not a UI error state — cached data
          // stands and the next tick retries.
          reportSyncFailed("mlgw");
        } finally {
          refreshing = false;
        }
      },

      toggleReview: async (config, billId, kind, reviewed, accountNumber) => {
        const before = get().data;
        if (!before) return false;
        const without = before.reviews.filter(
          (r) => !(r.billId === billId && r.exceptionKind === kind),
        );
        const next = reviewed ? [...without, optimisticReview(billId, kind, accountNumber)] : without;
        set({ data: { ...before, reviews: next } });
        try {
          await setMlgwReviewed({ billId, accountNumber, exceptionKind: kind, reviewed }, config);
          capture("utility_exception_reviewed", { kind, reviewed });
          return true;
        } catch {
          // Revert onto the CURRENT data (a sync may have landed meanwhile):
          // strip our optimistic row / restore the original one for this key.
          const current = get().data;
          if (current) {
            const rest = current.reviews.filter(
              (r) => !(r.billId === billId && r.exceptionKind === kind),
            );
            const original = before.reviews.find(
              (r) => r.billId === billId && r.exceptionKind === kind,
            );
            set({ data: { ...current, reviews: original ? [...rest, original] : rest } });
          }
          return false;
        }
      },
    }),
    {
      name: "emberly-manager-mlgw",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the payload survives restarts; flags are per-session.
      partialize: (s) => ({ data: s.data }),
    },
  ),
);

// Self-register with the sync tick (see lib/sync-registry.ts): cold cache
// takes the loadAll-style spinner path, every later tick refreshes silently.
registerSync("mlgw", async (config) => {
  const s = useMlgw.getState();
  if (s.data === null) await s.load(config);
  else await s.refresh(config);
});

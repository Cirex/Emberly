import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  createInsuranceAction,
  deleteInsuranceAction,
  fetchInsuranceBoard,
  type InsuranceAction,
  type InsuranceActionInput,
  type InsurancePolicy,
} from "@/lib/api/insurance";
import type { StaffConfig } from "@/lib/stores/config";
import { registerSync } from "@/lib/sync-registry";

/**
 * The insurance-compliance mirror: per-lease policies + the Emberly
 * follow-up trail (one payload), persisted so a relaunch opens on
 * yesterday's board while the sync tick refreshes behind it. Board math
 * (statuses, bands, distribution, timeline) lives in
 * lib/derived/insurance-view.ts — this store only owns fetch/cache/mutate,
 * with the same optimistic write-then-revert shape as the delinquency store.
 */
interface InsuranceState {
  policies: InsurancePolicy[];
  actions: InsuranceAction[];
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful refresh; 0 = never this install. */
  refreshedAt: number;
  load: (config: StaffConfig) => Promise<void>;
  refresh: (config: StaffConfig) => Promise<void>;
  /**
   * Optimistic action log: the row appears locally at once, the POST runs
   * behind it, and the server row replaces the local one on success. On
   * failure the local row is reverted and false returns so the sheet can
   * stay open with the draft intact.
   */
  logAction: (config: StaffConfig, input: InsuranceActionInput) => Promise<boolean>;
  /** Soft-delete an action (undo). Optimistic remove; restored on failure. */
  removeAction: (config: StaffConfig, id: string) => Promise<boolean>;
}

let refreshing = false;
let localSeq = 0;

export const useInsurance = create<InsuranceState>()(
  persist(
    (set, get) => ({
      policies: [],
      actions: [],
      loading: false,
      refreshedAt: 0,

      load: async (config) => {
        if (get().loading) return;
        // Spinner only on a truly cold cache; cached rows stay up otherwise.
        set({ loading: get().policies.length === 0, error: undefined });
        try {
          const board = await fetchInsuranceBoard(config);
          set({
            policies: board.policies,
            actions: board.actions,
            loading: false,
            refreshedAt: Date.now(),
          });
          reportSyncSucceeded("insurance");
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load" });
          reportSyncFailed("insurance");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const board = await fetchInsuranceBoard(config);
          const s = get();
          // Quiet tick: only write (and re-render) when the server moved.
          if (
            JSON.stringify(board.policies) !== JSON.stringify(s.policies) ||
            JSON.stringify(board.actions) !== JSON.stringify(s.actions)
          ) {
            set({ policies: board.policies, actions: board.actions });
          }
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("insurance");
        } catch {
          // Cached board stands; the next tick retries.
          reportSyncFailed("insurance");
        } finally {
          refreshing = false;
        }
      },

      logAction: async (config, input) => {
        const localId = `local-${Date.now()}-${localSeq++}`;
        const optimistic: InsuranceAction = {
          id: localId,
          resmanLeaseId: input.resmanLeaseId,
          unitNumber: input.unitNumber ?? "",
          kind: input.kind,
          note: input.note ?? "",
          createdBy: "",
          createdAt: new Date().toISOString(),
        };
        set({ actions: [optimistic, ...get().actions] });
        try {
          const stored = await createInsuranceAction(config, input);
          set({ actions: get().actions.map((a) => (a.id === localId ? stored : a)) });
          return true;
        } catch {
          set({ actions: get().actions.filter((a) => a.id !== localId) });
          return false;
        }
      },

      removeAction: async (config, id) => {
        const before = get().actions;
        const target = before.find((a) => a.id === id);
        if (!target) return false;
        set({ actions: before.filter((a) => a.id !== id) });
        try {
          await deleteInsuranceAction(config, id);
          return true;
        } catch {
          set({ actions: [target, ...get().actions] });
          return false;
        }
      },
    }),
    {
      name: "emberly-manager-insurance",
      storage: createJSONStorage(() => AsyncStorage),
      // Only data survives restarts; flags are per-session.
      partialize: (s) => ({
        policies: s.policies,
        actions: s.actions,
        refreshedAt: s.refreshedAt,
      }),
    },
  ),
);

// Self-register with the sync tick (lib/sync-registry.ts): cold cache takes
// the spinner path, every later tick is a silent refresh.
registerSync("insurance", async (config) => {
  const s = useInsurance.getState();
  if (s.policies.length === 0 && s.refreshedAt === 0) await s.load(config);
  else await s.refresh(config);
});

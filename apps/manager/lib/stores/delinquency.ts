import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  createDelinquencyAction,
  deleteDelinquencyAction,
  fetchDelinquencyBoard,
  fetchManagerLeases,
  type DelinquencyAction,
  type DelinquencyActionInput,
  type DelinquentUnit,
  type ManagerLease,
} from "@/lib/api/delinquency";
import type { StaffConfig } from "@/lib/stores/config";
import { registerSync } from "@/lib/sync-registry";

/**
 * The Delinquency (Money) board mirror: delinquent units + the Emberly action
 * timeline (one payload), plus the 24-month lease window that feeds agent
 * scorecards. All persisted so a relaunch opens on yesterday's board while
 * the sync tick refreshes behind it. Board math lives in
 * lib/derived/delinquency-view.ts — this store only owns fetch/cache/mutate.
 */
interface DelinquencyState {
  units: DelinquentUnit[];
  actions: DelinquencyAction[];
  leases: ManagerLease[];
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful refresh; 0 = never this install. */
  refreshedAt: number;
  load: (config: StaffConfig) => Promise<void>;
  refresh: (config: StaffConfig) => Promise<void>;
  /**
   * Optimistic action log: the row appears locally at once, the POST runs
   * behind it, and the server row replaces the local one on success. On
   * failure the local row is reverted and the error surfaces via the return
   * value (false) so the sheet can stay open with the draft intact.
   */
  logAction: (config: StaffConfig, input: DelinquencyActionInput) => Promise<boolean>;
  /** Soft-delete an action (undo). Optimistic remove; restored on failure. */
  removeAction: (config: StaffConfig, id: string) => Promise<boolean>;
}

async function fetchAll(config: StaffConfig): Promise<{
  units: DelinquentUnit[];
  actions: DelinquencyAction[];
  leases: ManagerLease[];
}> {
  const [board, leases] = await Promise.all([
    fetchDelinquencyBoard(config),
    fetchManagerLeases(config),
  ]);
  return { units: board.units, actions: board.actions, leases };
}

let refreshing = false;
let localSeq = 0;

export const useDelinquency = create<DelinquencyState>()(
  persist(
    (set, get) => ({
      units: [],
      actions: [],
      leases: [],
      loading: false,
      refreshedAt: 0,

      load: async (config) => {
        if (get().loading) return;
        // Spinner only on a truly cold cache; cached rows stay up otherwise.
        set({ loading: get().units.length === 0, error: undefined });
        try {
          const next = await fetchAll(config);
          set({ ...next, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("delinquency");
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load" });
          reportSyncFailed("delinquency");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const next = await fetchAll(config);
          const s = get();
          // Quiet tick: only write (and re-render) when the server moved.
          if (
            JSON.stringify(next.units) !== JSON.stringify(s.units) ||
            JSON.stringify(next.actions) !== JSON.stringify(s.actions) ||
            JSON.stringify(next.leases) !== JSON.stringify(s.leases)
          ) {
            set(next);
          }
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("delinquency");
        } catch {
          // Cached board stands; the next tick retries.
          reportSyncFailed("delinquency");
        } finally {
          refreshing = false;
        }
      },

      logAction: async (config, input) => {
        const localId = `local-${Date.now()}-${localSeq++}`;
        const optimistic: DelinquencyAction = {
          id: localId,
          resmanLeaseId: input.resmanLeaseId,
          resmanUnitId: input.resmanUnitId ?? "",
          unitNumber: input.unitNumber ?? "",
          kind: input.kind,
          note: input.note ?? "",
          amount: input.amount ?? null,
          promiseDueDate: input.promiseDueDate ?? null,
          createdBy: "",
          createdAt: new Date().toISOString(),
        };
        set({ actions: [optimistic, ...get().actions] });
        try {
          const stored = await createDelinquencyAction(config, input);
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
          await deleteDelinquencyAction(config, id);
          return true;
        } catch {
          set({ actions: [target, ...get().actions] });
          return false;
        }
      },
    }),
    {
      name: "emberly-manager-delinquency",
      storage: createJSONStorage(() => AsyncStorage),
      // Only data survives restarts; flags are per-session.
      partialize: (s) => ({
        units: s.units,
        actions: s.actions,
        leases: s.leases,
        refreshedAt: s.refreshedAt,
      }),
    },
  ),
);

// Self-register with the sync tick (lib/sync-registry.ts): cold cache takes
// the spinner path, every later tick is a silent refresh.
registerSync("delinquency", async (config) => {
  const s = useDelinquency.getState();
  if (s.units.length === 0 && s.leases.length === 0) await s.load(config);
  else await s.refresh(config);
});

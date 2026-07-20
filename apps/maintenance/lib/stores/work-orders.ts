import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { listWorkOrders, type WorkOrder } from "@/lib/api/work-orders";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The full work-order mirror, cached on device — the derived engine (filters,
 * groupings, analytics) runs over the complete set exactly like the Swift
 * app's SwiftData @Query did, so every mode switch and overlay is instant and
 * works offline.
 *
 * `dataVersion` increments only when a refresh actually changes rows; the
 * derived-snapshot memoization keys off it, so a quiet 60s poll that finds
 * nothing new re-renders nothing and recomputes nothing.
 */

interface WorkOrdersState {
  workOrders: WorkOrder[];
  dataVersion: number;
  loading: boolean;
  error?: string;
  loadAll: (config: StaffConfig) => Promise<void>;
  /** Silent background sync: skips the state write when nothing changed. */
  refresh: (config: StaffConfig) => Promise<void>;
}

const PAGE = 200;

/** Fetch every page of the unfiltered set. */
async function fetchAll(config: StaffConfig): Promise<WorkOrder[]> {
  const acc: WorkOrder[] = [];
  let offset = 0;
  for (;;) {
    const res = await listWorkOrders({ limit: PAGE, offset }, config);
    acc.push(...res.data);
    if (!res.pagination.hasMore) break;
    offset += PAGE;
    if (offset > 50_000) break; // safety valve
  }
  // Offset pagination can hand the same row back twice when the sync writes
  // between page fetches (rows shift under the cursor). Last write wins; the
  // id is the DB primary key so this is a pure dedupe, never a data loss.
  const byId = new Map<string, WorkOrder>();
  for (const row of acc) byId.set(row.resman_work_order_id, row);
  return [...byId.values()];
}

let refreshing = false;

export const useWorkOrders = create<WorkOrdersState>()(
  persist(
    (set, get) => ({
      workOrders: [],
      dataVersion: 0,
      loading: false,

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loading: get().workOrders.length === 0, error: undefined });
        try {
          const acc = await fetchAll(config);
          set((s) => ({ workOrders: acc, dataVersion: s.dataVersion + 1, loading: false }));
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load work orders" });
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const acc = await fetchAll(config);
          // The state only moves when the data did — a quiet 60s poll must not
          // rebuild the derived snapshot just to confirm nothing happened.
          const prev = get();
          if (JSON.stringify(acc) !== JSON.stringify(prev.workOrders)) {
            set((s) => ({ workOrders: acc, dataVersion: s.dataVersion + 1 }));
          }
        } catch {
          // Background sync failing is not an error state the UI should enter —
          // the cached data stands, and the next tick retries.
        } finally {
          refreshing = false;
        }
      },
    }),
    {
      name: "emberly-maintenance-work-orders",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data survives restarts; dataVersion restarts at whatever was
      // persisted, which is fine — it only needs to be monotonic per session.
      partialize: (s) => ({ workOrders: s.workOrders, dataVersion: s.dataVersion }),
    },
  ),
);

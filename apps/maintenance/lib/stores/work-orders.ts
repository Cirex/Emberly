import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
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
  /** Wall-clock ms of the last completed refresh (0 = never this session). */
  refreshedAt: number;
  /**
   * High-water mark of the SERVER's `updated_at`, used as the delta bound.
   *
   * Deliberately a server timestamp echoed back, never `Date.now()`: a device
   * clock that runs even slightly fast would ask for changes "since" a moment
   * the server hasn't reached and skip rows permanently. Empty until a full
   * load has landed.
   */
  deltaCursor: string;
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

/** Newest server `updated_at` across `rows`, or `fallback` when none is newer. */
function maxUpdatedAt(rows: readonly WorkOrder[], fallback: string): string {
  let max = fallback;
  for (const row of rows) {
    const stamp = row.updated_at ?? "";
    // ISO-8601 UTC strings from PostgREST sort lexicographically.
    if (stamp > max) max = stamp;
  }
  return max;
}

/** Page just the rows that changed since `since`. */
async function fetchSince(config: StaffConfig, since: string): Promise<WorkOrder[]> {
  const acc: WorkOrder[] = [];
  let offset = 0;
  for (;;) {
    const res = await listWorkOrders({ limit: PAGE, offset, updatedSince: since }, config);
    acc.push(...res.data);
    if (!res.pagination.hasMore) break;
    offset += PAGE;
    if (offset > 50_000) break;
  }
  return acc;
}

/**
 * The server's total row count, from a one-row request.
 *
 * This is how DELETIONS are caught. A delta read only ever reports rows that
 * still exist, so a work order removed from ResMan (and swept by the sync's
 * delete-missing pass) would otherwise sit on the device forever. Comparing the
 * count is exact and costs one tiny request — much better than "reconcile fully
 * every N minutes and hope".
 */
async function fetchTotalCount(config: StaffConfig): Promise<number> {
  const res = await listWorkOrders({ limit: 1 }, config);
  return res.pagination.count;
}

/**
 * Full read, used to establish the cursor and to recover whenever the delta
 * path can't be trusted (no cursor yet, or the row count drifted). Writes state
 * only when the data actually differs, so a reconcile that confirms the cache
 * re-renders nothing.
 */
async function fullSync(
  set: (partial: (s: WorkOrdersState) => Partial<WorkOrdersState>) => void,
  get: () => WorkOrdersState,
  config: StaffConfig,
): Promise<void> {
  const acc = await fetchAll(config);
  const changed = JSON.stringify(acc) !== JSON.stringify(get().workOrders);
  set((s) => ({
    ...(changed ? { workOrders: acc, dataVersion: s.dataVersion + 1 } : {}),
    deltaCursor: maxUpdatedAt(acc, ""),
    refreshedAt: Date.now(),
  }));
}

let refreshing = false;

export const useWorkOrders = create<WorkOrdersState>()(
  persist(
    (set, get) => ({
      workOrders: [],
      dataVersion: 0,
      refreshedAt: 0,
      deltaCursor: "",
      loading: false,

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run —
        // existing rows stay up while the refresh happens behind them.
        set({ loading: get().workOrders.length === 0, error: undefined });
        try {
          const acc = await fetchAll(config);
          set((s) => ({
            workOrders: acc,
            dataVersion: s.dataVersion + 1,
            loading: false,
            refreshedAt: Date.now(),
            deltaCursor: maxUpdatedAt(acc, ""),
          }));
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load work orders" });
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const cursor = get().deltaCursor;
          if (cursor === "") {
            // No cursor yet (fresh install, or a cache persisted before delta
            // sync existed) — one full read establishes it.
            await fullSync(set, get, config);
            reportSyncSucceeded("workOrders");
            return;
          }

          // Delta and total in parallel: what changed, and whether anything
          // vanished. Two small requests beat one full page.
          const [changed, total] = await Promise.all([
            fetchSince(config, cursor),
            fetchTotalCount(config),
          ]);

          const byId = new Map(get().workOrders.map((row) => [row.resman_work_order_id, row]));
          for (const row of changed) byId.set(row.resman_work_order_id, row);

          if (byId.size !== total) {
            // Row count disagrees with the server: something was deleted (or an
            // earlier delta was missed). Only a full read can tell which, and
            // guessing here would leave a phantom work order on the board.
            await fullSync(set, get, config);
            reportSyncSucceeded("workOrders");
            return;
          }

          if (changed.length > 0) {
            const merged = [...byId.values()];
            set((s) => ({
              workOrders: merged,
              dataVersion: s.dataVersion + 1,
              deltaCursor: maxUpdatedAt(changed, cursor),
              refreshedAt: Date.now(),
            }));
          } else {
            // Nothing moved. Advance only the freshness clock — touching
            // dataVersion would rebuild every derived snapshot to confirm that
            // nothing happened, which is the whole cost this avoids.
            set({ refreshedAt: Date.now() });
          }
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
      name: "emberly-maintenance-work-orders",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data survives restarts; dataVersion restarts at whatever was
      // persisted, which is fine — it only needs to be monotonic per session.
      partialize: (s) => ({ workOrders: s.workOrders, dataVersion: s.dataVersion }),
    },
  ),
);

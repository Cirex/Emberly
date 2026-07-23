import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  type TenantDetail,
  type TenantDetailsByUnit,
  getTenantDetail,
  listTenantDetails,
} from "@/lib/api/tenant-detail";
import type { ScannerConfig } from "@/lib/api/scanner";

interface TenantDetailsState {
  /** Every unit's detail pane, keyed by resman_unit_id. */
  byUnit: TenantDetailsByUnit;
  /** True only on a true first run — a warm cache refreshes behind the rows. */
  loading: boolean;
  /** Epoch ms of the last successful bulk load, for the "synced" caption. */
  syncedAt: number | null;
  /** Set only when a load failed and there's nothing cached to fall back on. */
  error: string;
  hydrated: boolean;
  /** Pull the whole property in one request and replace the cache. */
  loadAll: (config: ScannerConfig) => Promise<void>;
  /**
   * Re-read one unit and fold it into the cache. Used after a tap so the pane
   * self-corrects against the bulk snapshot without ever showing a spinner.
   */
  refreshUnit: (unitId: string, config: ScannerConfig) => Promise<void>;
}

/**
 * The tenant detail cache.
 *
 * Detail used to be fetched per unit on tap — six round trips deep, so vehicles
 * visibly popped in behind a spinner. The whole property now arrives in one
 * request on sync and lives on disk, so a tap renders from cache immediately and
 * only refreshes that unit in the background.
 */
export const useTenantDetails = create<TenantDetailsState>()(
  persist(
    (set, get) => ({
      byUnit: {},
      loading: false,
      syncedAt: null,
      error: "",
      hydrated: false,

      loadAll: async (config) => {
        if (get().loading) return;
        set({ loading: Object.keys(get().byUnit).length === 0 });
        try {
          const byUnit = await listTenantDetails(config);
          set({ byUnit, loading: false, syncedAt: Date.now(), error: "" });
        } catch (err) {
          // A failed refresh leaves the cached panes standing — the next tick
          // retries. Only a cold cache has nothing to show, so only then does
          // the failure become something the pane reports.
          const cold = Object.keys(get().byUnit).length === 0;
          set({
            loading: false,
            error: cold ? (err instanceof Error ? err.message : "Couldn't load tenant details") : "",
          });
        }
      },

      refreshUnit: async (unitId, config) => {
        try {
          const detail: TenantDetail = await getTenantDetail(unitId, config);
          set((s) => ({ byUnit: { ...s.byUnit, [unitId]: detail } }));
        } catch {
          // Silent: the cached pane is already on screen.
        }
      },
    }),
    {
      name: "emberly-security-tenant-details",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ byUnit: s.byUnit, syncedAt: s.syncedAt }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    },
  ),
);

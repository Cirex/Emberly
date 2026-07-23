import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { type PropertyMetrics, type ResmanConfig, getPropertyMetrics } from "@/lib/api/units";

/**
 * Property-wide headline counts (entries today, vehicles on file) for the
 * tenant dashboard cards. Persisted so the cards paint from cache instantly on
 * cold start, then refreshed on the shared 60s sync tick.
 *
 * Fail-soft by design: a failed refresh leaves the last known numbers in place
 * rather than blanking the cards — a stale count beats a spinner at a gate.
 */
interface MetricsState extends PropertyMetrics {
  loaded: boolean;
  refresh: (config: ResmanConfig) => Promise<void>;
}

let refreshing = false;

export const useMetrics = create<MetricsState>()(
  persist(
    (set) => ({
      entriesToday: 0,
      entriesGuestsToday: 0,
      vehicleCount: 0,
      loaded: false,

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const next = await getPropertyMetrics(config);
          set({ ...next, loaded: true });
        } catch {
          // Keep the cached numbers; the next tick retries.
        } finally {
          refreshing = false;
        }
      },
    }),
    {
      name: "emberly-security-metrics",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        entriesToday: s.entriesToday,
        entriesGuestsToday: s.entriesGuestsToday,
        vehicleCount: s.vehicleCount,
        loaded: s.loaded,
      }),
    },
  ),
);

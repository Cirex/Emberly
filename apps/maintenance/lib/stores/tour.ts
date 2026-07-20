import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { PLACED_UNITS } from "@/lib/map-data";
import { optimizeStops, type CompletedTour, type TourStop } from "@/lib/tour-optimize";

export type { CompletedTour, TourStop };

/**
 * Tour Mode — port of TourRoute/TourHistory from KrakenPropertyMap.
 *
 * Device-local by design (like the Swift original's map state): the route a
 * tech is walking belongs to their iPad, so the store persists straight to
 * AsyncStorage with no server sync. `setStops` exists so a future "My Day"
 * feature can inject an auto-generated batch wholesale.
 */

/** Unit-number → page-space centroid, for the route optimizer. */
const UNIT_CENTERS: ReadonlyMap<string, { x: number; y: number }> = new Map(
  PLACED_UNITS.map((u) => [u.number, { x: u.cx, y: u.cy }]),
);

let seq = 0;
const newId = () =>
  `tour-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface TourState {
  /** The active route, in walk order. */
  stops: TourStop[];
  /** Completed tours, newest first. */
  history: CompletedTour[];
  /** While on, tapping a map unit toggles it as a stop instead of selecting. */
  tourMode: boolean;
  setTourMode: (v: boolean) => void;
  /** Add the unit as a stop, or remove it if it's already on the route. */
  toggleStop: (unitNumber: string) => void;
  /** Replace the whole route (the "My Day" injection point). */
  setStops: (stops: TourStop[]) => void;
  toggleDone: (id: string) => void;
  setNote: (id: string, note: string) => void;
  removeStop: (id: string) => void;
  /** Swap the stop with its neighbor above (-1) or below (1). */
  moveStop: (id: string, direction: -1 | 1) => void;
  /** Nearest-neighbor reorder over unit centroids (TourRoute.optimized). */
  optimize: () => void;
  clearStops: () => void;
  /** Snapshot the route to the head of history and clear it. */
  completeTour: () => void;
  /** Archive an externally-built route (My Day's daily rollover) to history
   *  without touching the manual tour's own stops. */
  archiveCompleted: (stops: TourStop[]) => void;
  deleteHistory: (id: string) => void;
}

export const useTour = create<TourState>()(
  persist(
    (set, get) => ({
      stops: [],
      history: [],
      tourMode: false,

      setTourMode: (tourMode) => set({ tourMode }),

      toggleStop: (unitNumber) => {
        const stops = [...get().stops];
        const idx = stops.findIndex((s) => s.unitNumber === unitNumber);
        if (idx >= 0) stops.splice(idx, 1);
        else stops.push({ id: newId(), unitNumber, note: "", isDone: false });
        set({ stops });
      },

      setStops: (stops) => set({ stops }),

      toggleDone: (id) =>
        set({ stops: get().stops.map((s) => (s.id === id ? { ...s, isDone: !s.isDone } : s)) }),

      setNote: (id, note) =>
        set({ stops: get().stops.map((s) => (s.id === id ? { ...s, note } : s)) }),

      removeStop: (id) => set({ stops: get().stops.filter((s) => s.id !== id) }),

      moveStop: (id, direction) => {
        const stops = [...get().stops];
        const idx = stops.findIndex((s) => s.id === id);
        const to = idx + direction;
        if (idx < 0 || to < 0 || to >= stops.length) return;
        [stops[idx], stops[to]] = [stops[to], stops[idx]];
        set({ stops });
      },

      optimize: () => set({ stops: optimizeStops(get().stops, UNIT_CENTERS) }),

      clearStops: () => set({ stops: [] }),

      completeTour: () => {
        const { stops, history } = get();
        if (stops.length === 0) return;
        set({
          history: [{ id: newId(), completedAt: Date.now(), stops }, ...history],
          stops: [],
        });
      },

      archiveCompleted: (stops) => {
        if (stops.length === 0) return;
        set({ history: [{ id: newId(), completedAt: Date.now(), stops }, ...get().history] });
      },

      deleteHistory: (id) => set({ history: get().history.filter((h) => h.id !== id) }),
    }),
    {
      name: "emberly-maintenance-tour",
      storage: createJSONStorage(() => AsyncStorage),
      // tourMode is a live tool, not a preference — the app never reopens
      // with tap-to-toggle armed.
      partialize: (s) => ({ stops: s.stops, history: s.history }),
    },
  ),
);

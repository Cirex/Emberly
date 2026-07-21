import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * The property map's active lens, persisted per device. The manager map is a
 * READ surface in v1 — a lens only changes what paints the units:
 *
 *   heat   — balance-owed heat ramp (+ eviction override)
 *   groups — the leasing filter color groups (lib/stores/map-groups.ts)
 *   none   — the bare plan
 *
 * A future "utilities" lens (the cross-app utility layer) gets its pill today
 * but stays disabled until the annotation read path lands in this app.
 */
export type MapLens = "heat" | "groups" | "none";

interface MapLensState {
  lens: MapLens;
  setLens: (lens: MapLens) => void;
}

export const useMapLens = create<MapLensState>()(
  persist(
    (set) => ({
      lens: "heat",
      setLens: (lens) => set({ lens }),
    }),
    {
      name: "emberly-manager-map-lens",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

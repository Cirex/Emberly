import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Per-run visibility for the utility layer, persisted per device. Hiding a
 * run is a viewing choice, not an edit — the annotation itself stays on the
 * shared sync channel untouched, so a hidden run reappears on other devices
 * exactly as drawn. Ids of HIDDEN runs are stored (not shown ones) so a run
 * drawn on another device is visible here by default.
 */
interface UtilityVisibilityState {
  hiddenIds: string[];
  isHidden: (id: string) => boolean;
  toggle: (id: string) => void;
  /** The store's sync() swaps a local id for the server's on first push. */
  renameId: (from: string, to: string) => void;
}

export const useUtilityVisibility = create<UtilityVisibilityState>()(
  persist(
    (set, get) => ({
      hiddenIds: [],
      isHidden: (id) => get().hiddenIds.includes(id),
      toggle: (id) =>
        set((s) => ({
          hiddenIds: s.hiddenIds.includes(id)
            ? s.hiddenIds.filter((h) => h !== id)
            : [...s.hiddenIds, id],
        })),
      renameId: (from, to) =>
        set((s) => ({ hiddenIds: s.hiddenIds.map((h) => (h === from ? to : h)) })),
    }),
    {
      name: "emberly-maintenance-utility-visibility",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

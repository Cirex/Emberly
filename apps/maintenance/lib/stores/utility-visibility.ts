import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";

/**
 * Visibility for the utility layer, persisted per device, at two grains.
 *
 * PER LAYER (water, gas, internet…) is how a technician actually works: chasing
 * a water leak, everything else is noise. PER RUN stays for the finer case of
 * muting one drawn line.
 *
 * Hiding is a VIEWING CHOICE, NOT AN EDIT, at both grains — the annotations
 * themselves stay on the shared sync channel untouched, so nothing a technician
 * hides here disappears from a colleague's map. Hidden things are what gets
 * stored (rather than shown ones) so a layer or run created on another device is
 * visible here by default.
 */
interface UtilityVisibilityState {
  hiddenIds: string[];
  /** Utility types whose whole layer is hidden on this device. */
  hiddenTypes: string[];
  isHidden: (id: string) => boolean;
  isTypeHidden: (type: string) => boolean;
  /** True when the run is muted individually OR its layer is off. */
  isRunVisible: (id: string, type: string | null | undefined) => boolean;
  toggle: (id: string) => void;
  toggleType: (type: string) => void;
  /** The store's sync() swaps a local id for the server's on first push. */
  renameId: (from: string, to: string) => void;
}

export const useUtilityVisibility = create<UtilityVisibilityState>()(
  persist(
    (set, get) => ({
      hiddenIds: [],
      hiddenTypes: [],
      isHidden: (id) => get().hiddenIds.includes(id),
      isTypeHidden: (type) => get().hiddenTypes.includes(type),
      isRunVisible: (id, type) => {
        const s = get();
        if (s.hiddenIds.includes(id)) return false;
        // A run with no type belongs to no layer, so no layer can hide it.
        return type == null || !s.hiddenTypes.includes(type);
      },
      toggle: (id) =>
        set((s) => ({
          hiddenIds: s.hiddenIds.includes(id)
            ? s.hiddenIds.filter((h) => h !== id)
            : [...s.hiddenIds, id],
        })),
      toggleType: (type) =>
        set((s) => ({
          hiddenTypes: s.hiddenTypes.includes(type)
            ? s.hiddenTypes.filter((t) => t !== type)
            : [...s.hiddenTypes, type],
        })),
      renameId: (from, to) =>
        set((s) => ({ hiddenIds: s.hiddenIds.map((h) => (h === from ? to : h)) })),
    }),
    {
      name: "emberly-maintenance-utility-visibility",
      storage: persistedStorage(),
    },
  ),
);

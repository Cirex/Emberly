import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_ACCENT, type AccentThemeId, type AppThemePreference } from "@/theme/tokens";

interface SettingsState {
  /** Light/dark preference — mirrors iOS AppTheme (System/Light/Dark). */
  themePreference: AppThemePreference;
  /** Selected accent theme (5 options; default coral / "Liquid Glass"). */
  accentId: AccentThemeId;
  /** Human-readable relative dates toggle (iOS AppSettings.humanReadableDates). */
  humanReadableDates: boolean;
  /**
   * Daylight/outdoor mode: forces the light scheme and hardens the UI —
   * opaque surfaces and much stronger borders — so the app stays legible in
   * direct sun at a gate. Overrides themePreference while on.
   */
  fieldMode: boolean;
  /** Occupancy tint on the property map — off by default, remembered. */
  mapOccupancyTint: boolean;
  /** Camera pins/thumbnails on the property map — on by default, remembered.
   *  While off, the live thumbnail polling pauses too. */
  mapShowCameras: boolean;
  setThemePreference: (t: AppThemePreference) => void;
  setAccent: (a: AccentThemeId) => void;
  setHumanReadableDates: (v: boolean) => void;
  setFieldMode: (v: boolean) => void;
  setMapOccupancyTint: (v: boolean) => void;
  setMapShowCameras: (v: boolean) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      themePreference: "system",
      accentId: DEFAULT_ACCENT,
      humanReadableDates: true,
      fieldMode: false,
      mapOccupancyTint: false,
      mapShowCameras: true,
      setThemePreference: (themePreference) => set({ themePreference }),
      setAccent: (accentId) => set({ accentId }),
      setHumanReadableDates: (humanReadableDates) => set({ humanReadableDates }),
      setFieldMode: (fieldMode) => set({ fieldMode }),
      setMapOccupancyTint: (mapOccupancyTint) => set({ mapOccupancyTint }),
      setMapShowCameras: (mapShowCameras) => set({ mapShowCameras }),
    }),
    {
      name: "emberly-security-settings",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/** Convenience selector — surfaces read this to harden their styling. */
export const useFieldMode = () => useSettings((s) => s.fieldMode);

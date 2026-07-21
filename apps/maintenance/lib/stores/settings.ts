import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { changeAppLanguage, type AppLanguage } from "@/lib/i18n";
import { DEFAULT_ACCENT, type AccentThemeId, type AppThemePreference } from "@/theme/tokens";

interface SettingsState {
  /** UI language (AGENTS.md: language is app state in Zustand). */
  language: AppLanguage;
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
  setThemePreference: (t: AppThemePreference) => void;
  setAccent: (a: AccentThemeId) => void;
  setHumanReadableDates: (v: boolean) => void;
  setFieldMode: (v: boolean) => void;
  setMapOccupancyTint: (v: boolean) => void;
  setLanguage: (l: AppLanguage) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      language: "en",
      themePreference: "system",
      accentId: DEFAULT_ACCENT,
      humanReadableDates: true,
      fieldMode: false,
      mapOccupancyTint: false,
      setThemePreference: (themePreference) => set({ themePreference }),
      setAccent: (accentId) => set({ accentId }),
      setHumanReadableDates: (humanReadableDates) => set({ humanReadableDates }),
      setFieldMode: (fieldMode) => set({ fieldMode }),
      setMapOccupancyTint: (mapOccupancyTint) => set({ mapOccupancyTint }),
      setLanguage: (language) => {
        changeAppLanguage(language);
        set({ language });
      },
    }),
    {
      name: "emberly-maintenance-settings",
      storage: createJSONStorage(() => AsyncStorage),
      // Apply the persisted language to i18next once the store rehydrates —
      // without this, a relaunch would render English until Settings is opened.
      onRehydrateStorage: () => (state) => {
        if (state?.language) changeAppLanguage(state.language);
      },
    },
  ),
);

/** Convenience selector — surfaces read this to harden their styling. */
export const useFieldMode = () => useSettings((s) => s.fieldMode);

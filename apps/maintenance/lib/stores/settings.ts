import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
import { capture } from "@/lib/analytics";
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
  /** Utility layer (pins + drawn runs) on the property map — on by default. */
  utilityLayerVisible: boolean;
  /** Emergency work-order push notifications — on by default. */
  emergencyAlerts: boolean;
  setThemePreference: (t: AppThemePreference) => void;
  setAccent: (a: AccentThemeId) => void;
  setHumanReadableDates: (v: boolean) => void;
  setFieldMode: (v: boolean) => void;
  setUtilityLayerVisible: (v: boolean) => void;
  setEmergencyAlerts: (v: boolean) => void;
  setLanguage: (l: AppLanguage) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      language: "en",
      themePreference: "system",
      accentId: DEFAULT_ACCENT,
      humanReadableDates: true,
      fieldMode: false,
      utilityLayerVisible: true,
      emergencyAlerts: true,
      setThemePreference: (themePreference) => set({ themePreference }),
      setAccent: (accentId) => set({ accentId }),
      setHumanReadableDates: (humanReadableDates) => set({ humanReadableDates }),
      setFieldMode: (fieldMode) => set({ fieldMode }),
      setUtilityLayerVisible: (utilityLayerVisible) => set({ utilityLayerVisible }),
      setEmergencyAlerts: (emergencyAlerts) => set({ emergencyAlerts }),
      setLanguage: (language) => {
        // Only user-initiated changes report — rehydrate applies the persisted
        // language via onRehydrateStorage below, never through this setter.
        if (language !== get().language) capture("language_changed", { language });
        changeAppLanguage(language);
        set({ language });
      },
    }),
    {
      name: "emberly-maintenance-settings",
      storage: persistedStorage(),
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

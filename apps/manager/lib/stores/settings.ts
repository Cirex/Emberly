import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { capture } from "@/lib/analytics";
import { changeAppLanguage, type AppLanguage } from "@/lib/i18n";
import { MANAGER_ALERT_KINDS, type ManagerAlertKind } from "@/lib/push-routing";
import { DEFAULT_ACCENT, type AccentThemeId, type AppThemePreference } from "@/theme/tokens";

/** Per-kind push-alert opt-ins. Every kind defaults ON. */
export type AlertToggles = Record<ManagerAlertKind, boolean>;

function allAlertsOn(): AlertToggles {
  return Object.fromEntries(MANAGER_ALERT_KINDS.map((k) => [k, true])) as AlertToggles;
}

/**
 * The kinds this device wants, in a stable order. Sent to the server at
 * registration (push_tokens.alert_kinds) — filtering has to happen server-side
 * because the OS presents a backgrounded push before any app code runs.
 */
export function enabledAlertKinds(toggles: AlertToggles): ManagerAlertKind[] {
  return MANAGER_ALERT_KINDS.filter((kind) => toggles[kind] !== false);
}

interface SettingsState {
  /** UI language (AGENTS.md: language is app state in Zustand). */
  language: AppLanguage;
  /** Light/dark preference — mirrors iOS AppTheme (System/Light/Dark). */
  themePreference: AppThemePreference;
  /** Selected accent theme (5 options; default coral / "Liquid Glass"). */
  accentId: AccentThemeId;
  /** Human-readable relative dates toggle. */
  humanReadableDates: boolean;
  /**
   * Daylight/outdoor mode: forces the light scheme and hardens the UI —
   * opaque surfaces and much stronger borders. Kept in state (the ported
   * chrome components consume it) but not surfaced in Settings yet; a
   * manager walking the property may want it later.
   */
  fieldMode: boolean;
  /**
   * Push-alert opt-ins, one per alert kind, all on by default. Persisted and
   * mirrored to the server at registration; turning the last one off
   * unregisters the device entirely (see lib/push.ts).
   */
  alerts: AlertToggles;
  setAlertKind: (kind: ManagerAlertKind, enabled: boolean) => void;
  setThemePreference: (t: AppThemePreference) => void;
  setAccent: (a: AccentThemeId) => void;
  setHumanReadableDates: (v: boolean) => void;
  setFieldMode: (v: boolean) => void;
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
      alerts: allAlertsOn(),
      setAlertKind: (kind, enabled) =>
        set((s) => ({ alerts: { ...s.alerts, [kind]: enabled } })),
      setThemePreference: (themePreference) => set({ themePreference }),
      setAccent: (accentId) => set({ accentId }),
      setHumanReadableDates: (humanReadableDates) => set({ humanReadableDates }),
      setFieldMode: (fieldMode) => set({ fieldMode }),
      setLanguage: (language) => {
        // Only user-initiated changes report — rehydrate applies the persisted
        // language via onRehydrateStorage below, never through this setter.
        if (language !== get().language) capture("language_changed", { language });
        changeAppLanguage(language);
        set({ language });
      },
    }),
    {
      name: "emberly-manager-settings",
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

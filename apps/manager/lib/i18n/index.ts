import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { common } from "./catalogs/common";
import { delinquency } from "./catalogs/delinquency";
import { leasing } from "./catalogs/leasing";
import { map } from "./catalogs/map";
import { settings } from "./catalogs/settings";
import { today } from "./catalogs/today";
import { utilities } from "./catalogs/utilities";

/**
 * App i18n (AGENTS.md · Localization): i18next with English as the source
 * language and Spanish required for user-facing text. Keys are scoped and
 * stable ("settings.appearance", "leasing.title"); counts use i18next plurals
 * (_one/_other); brand names (Emberly, ResMan), IDs, unit numbers, and machine
 * values are never translated.
 *
 * MODULAR CATALOGS: each feature owns one file in ./catalogs exporting
 * `{ en: {...}, es: {...} }` whose top-level key(s) are that feature's
 * namespace ("today", "leasing", …). This index merges them into the single
 * `translation` namespace, so call sites use plain `t("leasing.title")`.
 * Because every catalog owns distinct top-level keys, a shallow spread is a
 * safe merge — wave-2 agents add strings ONLY inside their own catalog file
 * (plus this list if they add a brand-new catalog).
 *
 * The selected language lives in the settings store (Zustand, persisted) —
 * `setLanguage` there calls `changeAppLanguage`. Default is English; there is
 * no native locale-detection dependency by design (JS-only, no pod churn).
 */

export type AppLanguage = "en" | "es";

const CATALOGS = [common, today, leasing, delinquency, utilities, map, settings] as const;

const en = Object.assign({}, ...CATALOGS.map((c) => c.en)) as Record<string, unknown>;
const es = Object.assign({}, ...CATALOGS.map((c) => c.es)) as Record<string, unknown>;

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Switch the app language. Called by the settings store; components re-render
 *  via useTranslation. */
export function changeAppLanguage(language: AppLanguage): void {
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

/** The active locale tag for date formatting (toLocaleDateString etc.). */
export function activeLocale(): string {
  return i18n.language === "es" ? "es" : "en";
}

export default i18n;

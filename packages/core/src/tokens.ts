/**
 * Runtime design tokens (values the Tailwind config can't express as static
 * utilities). Static brand/surface colors live in tailwind.config.js; this file
 * holds the runtime-swappable accent themes and status-tint lookups.
 *
 * Source of truth: AppSettings.swift (AppAccentColorOption) + AppStatusTint.swift.
 */

/** Space-separated RGB channels, for CSS `rgb(var(--x) / <alpha>)`. */
export type RgbChannels = `${number} ${number} ${number}`;

export type AccentThemeId = "coral" | "blue" | "emerald" | "plum" | "graphite";

export interface AccentTheme {
  id: AccentThemeId;
  /** UI label (matches the iOS titles). */
  label: string;
  header: RgbChannels;
  selection: RgbChannels;
  metricValue: RgbChannels;
}

/** The 5 selectable accents. Default = coral ("Liquid Glass"). */
export const ACCENT_THEMES: Record<AccentThemeId, AccentTheme> = {
  coral: { id: "coral", label: "Liquid Glass", header: "110 129 153", selection: "52 62 77", metricValue: "239 246 255" },
  blue: { id: "blue", label: "Blue", header: "37 74 130", selection: "30 52 85", metricValue: "227 241 255" },
  emerald: { id: "emerald", label: "Emerald", header: "31 128 92", selection: "11 72 51", metricValue: "223 250 236" },
  plum: { id: "plum", label: "Plum", header: "120 64 173", selection: "67 27 111", metricValue: "243 232 255" },
  graphite: { id: "graphite", label: "Graphite", header: "59 62 72", selection: "27 29 37", metricValue: "237 241 247" },
};

export const DEFAULT_ACCENT: AccentThemeId = "coral";

/** Map an accent theme to the CSS variables consumed by tailwind.config.js. */
export function accentVars(id: AccentThemeId): Record<string, string> {
  const t = ACCENT_THEMES[id] ?? ACCENT_THEMES[DEFAULT_ACCENT];
  return {
    "--accent-header": t.header,
    "--accent-selection": t.selection,
    "--accent-metric-value": t.metricValue,
  };
}

/** Status tints (hex) for dynamic status → color lookups. */
export const STATUS_TINT = {
  ready: "#33A666",
  affirm: "#8FD36A",
  blocked: "#D1382E",
  warning: "#E38736",
  attention: "#EB852E",
  hold: "#D19438",
  info: "#458ADB",
  accentBlue: "#3D87E0",
  closed: "#3D9461",
  review: "#7A6BC7",
  denied: "#D12E21",
} as const;

export type StatusTint = keyof typeof STATUS_TINT;

/**
 * Brand neutrals + accent palette shared across the maintenance UI. These were
 * previously re-declared per-file (NAVY/MUTED/HAIRLINE ~13 times, with the OLIVE
 * name bound to two different hexes and the callback tint split two ways); they
 * live here now as the single source of truth.
 */

/** Deep brand navy — primary ink, shadows, dark section bands. */
export const NAVY = "#091B54";
/** Muted slate — secondary text, idle icons, meta. */
export const MUTED = "#70788F";

/**
 * Hairline border tints (navy at graded alpha, tuned per surface density).
 * Denser surfaces (tables, boards) use the soft step; floating glass uses strong.
 */
export const HAIRLINE_SOFT = "rgba(9,27,84,0.06)";
export const HAIRLINE = "rgba(9,27,84,0.09)";
export const HAIRLINE_STRONG = "rgba(9,27,84,0.12)";

/**
 * Olive accent family — three distinct roles:
 *  - OLIVE: bright accent for fills, progress bars, badges, tour pins.
 *  - OLIVE_TEXT: darker olive for text/icons on light surfaces (contrast).
 *  - OLIVE_GLASS / OLIVE_GLASS_DARK: accent tint for content inside glass
 *    chrome (GlassHeader, selected FloatingTabBar tab), light/dark paired.
 */
export const OLIVE = "#A2A921";
export const OLIVE_TEXT = "#848F0D";
export const OLIVE_GLASS = "#6F7A0B";
export const OLIVE_GLASS_DARK = "#D6DE7A";

/** "Possible callback" signal tint (WO lists, analytics, detail). */
export const CALLBACK_TINT = "#5B4BA8";

/** Leasing classification tints (hex). */
export const CLASSIFICATION_TINT = {
  ruby: "#9C101F",
  diamond: "#388FC7",
  legacy: "#9E805C",
  lux: "#C79433",
} as const;

/** App theme (light/dark) preference — mirrors iOS AppTheme. */
export type AppThemePreference = "system" | "light" | "dark";

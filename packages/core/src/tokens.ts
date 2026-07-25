/**
 * Runtime design tokens (values the Tailwind config can't express as static
 * utilities). Static brand/surface colors live in tailwind.config.js; this file
 * holds the runtime-swappable accent themes and status-tint lookups.
 *
 * Source of truth: AppSettings.swift (AppAccentColorOption) + AppStatusTint.swift.
 */

/** Space-separated RGB channels, for CSS `rgb(var(--x) / <alpha>)`. */
export type RgbChannels = `${number} ${number} ${number}`;

export type AccentThemeId = "olive" | "blue" | "emerald" | "plum" | "ember" | "graphite";

export interface AccentTheme {
  id: AccentThemeId;
  /** UI label. Colour names, so they are not translated. */
  label: string;
  /**
   * The accent itself, as a hex string.
   *
   * Everything that is not a Tailwind class needs this: `tintColor` on the
   * Emberly mark, Skia paints, icon colours. The channel triples below exist
   * only because CSS variables must be `rgb(var(--x) / <alpha>)`.
   */
  hex: string;
  header: RgbChannels;
  /** A deeper tone for selected chrome, so a filled state stays legible. */
  selection: RgbChannels;
  /** A pale tone for numerals sitting on the accent. */
  metricValue: RgbChannels;
}

/**
 * The selectable accents.
 *
 * REPLACED the five ported from the Swift app, which were muted chrome tones
 * rather than accents — the old default, "Liquid Glass", was rgb(110 129 153),
 * a grey-blue, and set side by side the five were nearly indistinguishable.
 * That is part of why nobody noticed the picker was wired to nothing.
 *
 * Default is olive: the Emberly brand colour, and the colour the mark is
 * already drawn in, so a fresh install looks exactly as it did before.
 *
 * Ids are the persisted value. `blue`, `emerald`, `plum` and `graphite` keep
 * theirs; the retired `coral` falls through to the default via the lookups
 * below, which is why they are written defensively.
 */
export const ACCENT_THEMES: Record<AccentThemeId, AccentTheme> = {
  olive: { id: "olive", label: "Olive", hex: "#A2A921", header: "162 169 33", selection: "107 116 17", metricValue: "240 243 214" },
  blue: { id: "blue", label: "Harbor", hex: "#2563B4", header: "37 99 180", selection: "25 66 120", metricValue: "227 241 255" },
  emerald: { id: "emerald", label: "Emerald", hex: "#1F805C", header: "31 128 92", selection: "16 84 60", metricValue: "223 250 236" },
  plum: { id: "plum", label: "Plum", hex: "#7840AD", header: "120 64 173", selection: "78 40 115", metricValue: "243 232 255" },
  ember: { id: "ember", label: "Ember", hex: "#C2410C", header: "194 65 12", selection: "128 42 8", metricValue: "255 236 222" },
  graphite: { id: "graphite", label: "Graphite", hex: "#3B3E48", header: "59 62 72", selection: "33 35 42", metricValue: "237 241 247" },
};

export const DEFAULT_ACCENT: AccentThemeId = "olive";

/** The chosen theme, falling back when a device holds a retired id. */
export function accentTheme(id: AccentThemeId): AccentTheme {
  return ACCENT_THEMES[id] ?? ACCENT_THEMES[DEFAULT_ACCENT];
}

/** The accent as a hex string — for tintColor, Skia, and icon colours. */
export function accentHex(id: AccentThemeId): string {
  return accentTheme(id).hex;
}

/** Map an accent theme to the CSS variables consumed by tailwind.config.js. */
export function accentVars(id: AccentThemeId): Record<string, string> {
  const t = accentTheme(id);
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

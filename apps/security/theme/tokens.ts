/**
 * Design tokens now live in @emberly/core, shared by the security and
 * maintenance apps. This thin re-export keeps the `@/theme/tokens` import path
 * working for existing callers; it can be collapsed once they import from
 * @emberly/core directly.
 */
export {
  ACCENT_THEMES,
  DEFAULT_ACCENT,
  accentVars,
  STATUS_TINT,
  CLASSIFICATION_TINT,
} from "@emberly/core";
export type {
  RgbChannels,
  AccentThemeId,
  AccentTheme,
  StatusTint,
  AppThemePreference,
} from "@emberly/core";

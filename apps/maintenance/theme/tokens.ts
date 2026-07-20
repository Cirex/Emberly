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
  NAVY,
  MUTED,
  HAIRLINE_SOFT,
  HAIRLINE,
  HAIRLINE_STRONG,
  OLIVE,
  OLIVE_TEXT,
  OLIVE_GLASS,
  OLIVE_GLASS_DARK,
  CALLBACK_TINT,
} from "@emberly/core";
export type {
  RgbChannels,
  AccentThemeId,
  AccentTheme,
  StatusTint,
  AppThemePreference,
} from "@emberly/core";

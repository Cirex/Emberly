/**
 * Design tokens live in @emberly/core, shared across the Emberly apps. This
 * thin re-export keeps the `@/theme/tokens` import path identical to the
 * maintenance app so ported components (and wave-2 feature work) read the
 * same names everywhere.
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

/**
 * Shared screen-chrome geometry. Every tab places the AccountMenu pill (and
 * its surrounding header chrome) with THESE values so the pill sits at the
 * exact same spot on all screens instead of jumping a few points per tab:
 * top = safe-area inset + HEADER_TOP_PAD, side inset = screenHPad(width).
 */
export const HEADER_TOP_PAD = 10;
export const screenHPad = (width: number): number => (width >= 1040 ? 34 : 20);

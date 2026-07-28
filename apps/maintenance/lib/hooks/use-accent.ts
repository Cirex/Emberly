import { useMemo } from "react";
import { useSettings } from "@/lib/stores/settings";
import { accentHex, accentTheme, type AccentTheme } from "@/theme/tokens";

/**
 * The chosen accent, for everything Tailwind cannot reach.
 *
 * The accent was plumbed as three CSS variables and nothing else: `accentVars`
 * fed `tailwind.config.js`, which exposed `accent.header` / `accent.selection` /
 * `accent.metric` — classes NO file in the app ever used. Every surface
 * hardcoded olive or navy, so picking an accent persisted a value that no pixel
 * read. These hooks are the other half: React Native props (`tintColor`, icon
 * `color`, border colours) take strings, not classes.
 *
 * What the accent is allowed to tint is deliberately bounded. Identity and
 * navigation chrome, yes. STATUS COLOUR, NEVER — red means emergency and green
 * means done regardless of anyone's preference, so those stay in STATUS_TINT.
 * Classification tints and the purple callback signal are semantic too, and
 * likewise stay fixed.
 */

/** The accent as a hex string — the FILL tone. Not safe for small text. */
export function useAccentHex(): string {
  return accentHex(useSettings((s) => s.accentId));
}

/** The full theme, when the deeper selection tone is needed too. */
export function useAccentTheme(): AccentTheme {
  return accentTheme(useSettings((s) => s.accentId));
}

/**
 * The accent resolved into the four roles the UI actually draws with.
 *
 * This is what replaced importing OLIVE / OLIVE_TEXT / OLIVE_GLASS /
 * OLIVE_GLASS_DARK at 117 call sites. The names are roles rather than colours so
 * a call site says what it means — `palette.text` is "accent, legible on paper",
 * not "a darker olive" — which is what makes the sweep checkable by reading it.
 */
export interface AccentPalette {
  /** Bars, dots, badges, journey nodes, map pins. Bright; not for small text. */
  fill: string;
  /** Labels, icons, selected states, primary buttons on light surfaces. Clears 4.5:1 on paper. */
  text: string;
  /** Accent inside light glass chrome, which lifts the surface and eats contrast. */
  glass: string;
  /** Accent inside dark glass chrome. */
  glassDark: string;
  /** Whichever of the two suits the current colour scheme. */
  glassFor: (dark: boolean) => string;
  /** Backdrop wash tints — upper-left, upper-right, lower-right. */
  glowLight: readonly [string, string, string];
  glowDark: readonly [string, string, string];
}

export function useAccentPalette(): AccentPalette {
  const accentId = useSettings((s) => s.accentId);
  // Memoized on the id, not rebuilt per render: the object is read inside
  // useMemo/useCallback deps and handed to memoized children in several places,
  // and a fresh identity every render would quietly defeat both.
  return useMemo(() => {
    const theme = accentTheme(accentId);
    return {
      fill: theme.hex,
      text: theme.text,
      glass: theme.glass,
      glassDark: theme.glassDark,
      glassFor: (dark: boolean) => (dark ? theme.glassDark : theme.glass),
      glowLight: theme.glowLight,
      glowDark: theme.glowDark,
    };
  }, [accentId]);
}

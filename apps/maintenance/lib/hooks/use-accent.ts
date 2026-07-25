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
 */

/** The accent as a hex string. */
export function useAccentHex(): string {
  return accentHex(useSettings((s) => s.accentId));
}

/** The full theme, when the deeper selection tone is needed too. */
export function useAccentTheme(): AccentTheme {
  return accentTheme(useSettings((s) => s.accentId));
}

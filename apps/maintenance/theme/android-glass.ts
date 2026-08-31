import { Platform } from "react-native";

/**
 * ANDROID GLASS IS OPAQUE, EVERYWHERE, ON PURPOSE.
 *
 * expo-blur renders no blur on Android: BlurView's blurMethod defaults to
 * 'none' and the fallback is a flat wash at intensity/100 * 0.78 opacity. On
 * iOS the translucency reads as glass because the blur separates the surface
 * from what's behind it. Without the blur it is just a thin veil — a 40%-white
 * tab bar sits over the live property map and the map's own lines and unit
 * numbers read straight through it, and a 72% sheet lets the list it covers
 * show through its own text.
 *
 * Dimezis blur would restore the real effect, but it needs a blurTarget ref
 * threaded through every one of the twelve call sites. Opaque is the honest
 * fix, and it is the SAME call field mode already makes on both platforms.
 *
 * This module exists so that call is made once. The security app has a single
 * glass component and could inline its palette; maintenance has twelve, and
 * twelve independent judgements is how an app ends up half-ported and looking
 * broken in a way neither platform explains.
 *
 * FIELD MODE IS DELIBERATELY ABSENT FROM THIS PALETTE. It already forces an
 * opaque light treatment on both platforms, for exactly this reason — glass
 * is what dies in direct sunlight. Every Android branch below is written
 * `OPAQUE_GLASS && !field` at the call site, so field mode keeps its one
 * definition and Android never gets a second, drifting copy of it. (Four
 * sites — the modal sheets, the analytics overlay and the detail chrome —
 * have no field branch on iOS either; there the Android branch is
 * unconditional.)
 */
export const OPAQUE_GLASS = Platform.OS === "android";

/**
 * The three materials the twelve sites actually use. Each fill is that
 * surface's own iOS tint resolved to full alpha over what sits behind it,
 * nudged where the surface needs to keep separating from its backdrop now
 * that the blur no longer does that job.
 *
 * Dark tones stay in the neutral charcoal family the dark-mode pass
 * established (WorkspaceBackdrop's #14181F → #12171A base, the sheets'
 * rgba(20,24,31)); they are lifts ABOVE that backdrop, not the navy-blue
 * family security uses.
 */
const ANDROID_FILL = {
  /** Floating controls and bars: tab bar, account chip, action bars, pills. */
  chrome: {
    light: { base: "#FFFFFF", active: "#F1EFE6" },
    dark: { base: "#232833", active: "#2E3440" },
  },
  /**
   * List cards on the workspace backdrop — one step quieter than chrome, and
   * unchanged when selected: a selected card is marked by its accent border,
   * never by its fill, and that stays true here.
   */
  card: {
    light: { base: "#FFFFFF", active: "#FFFFFF" },
    dark: { base: "#1E222B", active: "#1E222B" },
  },
  /** Modal sheets, dropdown panels and the sticky header: warm paper / ink. */
  panel: {
    light: { base: "#FCFAF4", active: "#F1EFE6" },
    dark: { base: "#1A1F27", active: "#242A34" },
  },
} as const;

export type GlassRole = keyof typeof ANDROID_FILL;

/** The opaque fill for one role. Only ever called when `OPAQUE_GLASS`. */
export function androidGlassFill(role: GlassRole, dark: boolean, active = false): string {
  return ANDROID_FILL[role][dark ? "dark" : "light"][active ? "active" : "base"];
}

/**
 * These surfaces stroke themselves with white on iOS, which works because the
 * blur darkens whatever is under the edge. Against an opaque white fill that
 * stroke is simply invisible, so light mode takes the navy hairline instead —
 * the same one field mode uses, at a lower weight. Dark mode's white@10-12%
 * stroke still reads against a charcoal fill and is left alone.
 */
export const ANDROID_GLASS_HAIRLINE = "rgba(9,27,84,0.12)";

/**
 * React Native ignores shadowColor/shadowOpacity/shadowRadius on Android; the
 * blur was supplying the lift on these surfaces anyway. Elevation replaces
 * both. Chrome floats over content, panels float over a scrim.
 */
export const ANDROID_GLASS_ELEVATION = 3;
export const ANDROID_PANEL_ELEVATION = 8;

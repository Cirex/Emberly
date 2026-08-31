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
 * A surface's fill. `active` is optional: most materials do not change colour
 * when selected — a chosen work-order card is marked by its accent border,
 * and a sheet has no selected state at all — so they define `base` only and
 * `androidGlassFill` falls through to it. Only chrome, whose controls have a
 * real pressed/selected tone, carries an `active`.
 */
type GlassTone = { readonly base: string; readonly active?: string };

/**
 * The four materials the twelve sites actually use. Each fill is that
 * surface's own iOS tint resolved to full alpha over what sits behind it,
 * nudged where the surface needs to keep separating from its backdrop now
 * that the blur no longer does that job.
 *
 * Dark tones stay in the neutral charcoal family the dark-mode pass
 * established (WorkspaceBackdrop's #14181F → #12171A base, the sheets'
 * rgba(20,24,31)); they are lifts ABOVE that backdrop, not the navy-blue
 * family security uses. The one exception is `header`, which is a lift BELOW
 * it — see that role.
 */
const ANDROID_FILL = {
  /** Floating controls and bars: tab bar, account chip, action bars, pills. */
  chrome: {
    light: { base: "#FFFFFF", active: "#F1EFE6" },
    dark: { base: "#232833", active: "#2E3440" },
  },
  /**
   * List cards on the workspace backdrop. In DARK this is a step quieter than
   * chrome (#1E222B under #232833); in light both are plain #FFFFFF and the
   * card is told apart from the bar floating over it by border and elevation
   * alone, not by tone — do not read a light-mode separation into this.
   */
  card: {
    light: { base: "#FFFFFF" },
    dark: { base: "#1E222B" },
  },
  /** Modal sheets and dropdown panels, over a dimming scrim: warm paper / ink. */
  panel: {
    light: { base: "#FCFAF4" },
    dark: { base: "#1A1F27" },
  },
  /**
   * The sticky work-order header. NOT `panel`, though it looks like one: a
   * panel floats over a scrim that supplies its separation, while this sits
   * directly on the workspace with cards scrolling underneath it.
   *
   * Given `panel`'s tones it lost that separation entirely on Android. In
   * dark, #1A1F27 is only 1.07:1 above the #14181F backdrop AND *lighter*
   * than the #1E222B cards passing under it — the layering polarity inverts,
   * so the header reads as a card that stopped scrolling. On iOS the same
   * header composites to roughly #131720, i.e. DARKER than the backdrop.
   *
   * So dark takes #0F131A, which restores that polarity (1.17:1 against the
   * cards, and on the correct side of them), and light takes the workspace
   * paper #FAF7F0 exactly — which is what the iOS rgba(250,247,240,0.42)
   * tint resolves to over that paper, rather than `panel`'s two-units-lighter
   * sheet white. Separation in light comes from the hairline and elevation.
   */
  header: {
    light: { base: "#FAF7F0" },
    dark: { base: "#0F131A" },
  },
} as const satisfies Record<string, { light: GlassTone; dark: GlassTone }>;

export type GlassRole = keyof typeof ANDROID_FILL;

/** The opaque fill for one role. Only ever called when `OPAQUE_GLASS`. */
export function androidGlassFill(role: GlassRole, dark: boolean, active = false): string {
  const tone: GlassTone = ANDROID_FILL[role][dark ? "dark" : "light"];
  return (active && tone.active) || tone.base;
}

/**
 * The tab bar's selected-tab lozenge, which is the one surface here that
 * cannot take its material from a role.
 *
 * It is white-on-glass on iOS, so over an OPAQUE white capsule it would be a
 * 1.15:1 ghost, and it cannot be given an elevation to compensate: Android
 * draws elevated views above their lower siblings, so a lifted lozenge would
 * paint straight over the icon and label it is supposed to sit behind.
 *
 * That leaves tone, and tone pulls in one direction only. Going LIGHTER (the
 * Material 3 active-indicator habit) buys separation from the capsule but
 * spends it on the ink: the focused tab draws its icon and label in the raw
 * accent for every accent except olive, so a lighter lozenge drops blue to
 * 3.40:1 and graphite to 2.62:1. Going DARKER buys both — 1.23:1 against the
 * capsule in each scheme, and blue back to 4.93:1, graphite to 3.81:1, olive
 * to 11.19:1. So the lozenge is a well on Android rather than a lift.
 *
 * The affordance never rode on this anyway: the focused tab also takes the
 * accent for its icon and label at weight 700, which is what actually says
 * "selected" — the lozenge reinforces it.
 */
export const ANDROID_LOZENGE_FILL = { light: "#ECE8DA", dark: "#12161E" } as const;

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
 * both, and must sit on the view that carries the BACKGROUND — Android casts
 * the shadow from the background drawable's outline, so putting it on a
 * transparent clipping parent gets nothing.
 *
 * Chrome floats over content. The sticky header gets more, because it has
 * content moving continuously beneath it and no scrim to separate against;
 * this is the Material app-bar-with-content-scrolled-under value.
 */
export const ANDROID_GLASS_ELEVATION = 3;
export const ANDROID_HEADER_ELEVATION = 8;

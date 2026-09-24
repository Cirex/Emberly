/**
 * The iOS glass recipe for floating chrome — the tab capsule, the search
 * bubble, GlassSurface controls, the header mode pill — in ONE place.
 *
 * Each of those used to carry its own inline alphas, and the dark values had
 * drifted to a 5-6% white wash over a dark-tinted blur. Over the app's dark
 * paper that composites to almost exactly the background: the search bubble,
 * which has no tab labels to outline it, read as a bare floating magnifier with
 * no surface at all. Dark glass needs MORE fill and a brighter rim than light
 * glass, not less, because the blur samples dark content and adds no contrast
 * of its own.
 *
 * Light values are unchanged from the inline originals. Field mode and Android
 * keep their own opaque recipes (settings field mode, @/theme/android-glass).
 */
export interface GlassRecipe {
  /** Tint laid OVER the blur. */
  fill: string;
  /** The selected/active tint. */
  fillActive: string;
  /** The 1px rim. */
  border: string;
  /** expo-blur intensity. */
  blur: number;
}

export const GLASS: Record<"light" | "dark", GlassRecipe> = {
  light: {
    fill: "rgba(255,255,255,0.40)",
    fillActive: "rgba(255,255,255,0.55)",
    border: "rgba(255,255,255,0.30)",
    blur: 40,
  },
  dark: {
    fill: "rgba(255,255,255,0.12)",
    fillActive: "rgba(255,255,255,0.20)",
    border: "rgba(255,255,255,0.22)",
    blur: 50,
  },
};

import { Image } from "react-native";

// The real brand artwork. `logo-full` is the stacked lockup (flower over a serif
// EMBERLY over tracked APARTMENTS); `logo-flower` is the mark on its own;
// `logo-reversed` is the white-on-transparent lockup for dark grounds (the same
// asset the admin portal sidebar serves from apps/web/public).
const flower = require("../assets/logo-flower.png");
const full = require("../assets/logo-full.png");
const reversed = require("../assets/logo-reversed.png");

// Intrinsic aspect of logo-full.png (3750×2500).
const FULL_ASPECT = 3750 / 2500;
// Intrinsic aspect of logo-reversed.png (480×313).
const REVERSED_ASPECT = 480 / 313;

interface EmberlyBrandLogoProps {
  /** "full" is the stacked lockup; "flower" is the mark on its own;
   *  "reversed" is the white lockup for dark grounds (navy rails, headers). */
  variant?: "full" | "flower" | "reversed";
  /** Height in px. The lockups take their width from the artwork's aspect. */
  size?: number;
}

/**
 * The wordmark used to be recomposed at runtime (flower + Georgia "EMBERLY" +
 * tracked "APARTMENTS") because iOS draws it in New York and Georgia was the
 * nearest RN face. It never matched — the real lockup is stacked rather than
 * side-by-side, and the substitute face read as visibly wrong — so all variants
 * now render the real artwork.
 *
 * The full lockup needs room to stay legible: at header sizes its wordmark
 * collapses to a few pixels, so prefer "flower" there and "full" only where the
 * layout can give it space. On dark grounds use "reversed" — the dark lockup
 * disappears into a navy rail.
 */
export function EmberlyBrandLogo({ variant = "full", size = 40 }: EmberlyBrandLogoProps) {
  if (variant === "flower") {
    return (
      <Image
        source={flower}
        style={{ width: size, height: size }}
        resizeMode="contain"
        accessibilityLabel="Emberly"
      />
    );
  }

  if (variant === "reversed") {
    return (
      <Image
        source={reversed}
        style={{ width: size * REVERSED_ASPECT, height: size }}
        resizeMode="contain"
        accessibilityLabel="Emberly Apartments"
      />
    );
  }

  return (
    <Image
      source={full}
      style={{ width: size * FULL_ASPECT, height: size }}
      resizeMode="contain"
      accessibilityLabel="Emberly Apartments"
    />
  );
}

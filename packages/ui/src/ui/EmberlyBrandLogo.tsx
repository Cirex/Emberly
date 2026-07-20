import { Image } from "react-native";

// The real brand artwork. `logo-full` is the stacked lockup (flower over a serif
// EMBERLY over tracked APARTMENTS); `logo-flower` is the mark on its own.
const flower = require("../assets/logo-flower.png");
const full = require("../assets/logo-full.png");

// Intrinsic aspect of logo-full.png (3750×2500).
const FULL_ASPECT = 3750 / 2500;

interface EmberlyBrandLogoProps {
  /** "full" is the stacked lockup; "flower" is the mark on its own. */
  variant?: "full" | "flower";
  /** Height in px. The full lockup takes its width from the artwork's aspect. */
  size?: number;
}

/**
 * The wordmark used to be recomposed at runtime (flower + Georgia "EMBERLY" +
 * tracked "APARTMENTS") because iOS draws it in New York and Georgia was the
 * nearest RN face. It never matched — the real lockup is stacked rather than
 * side-by-side, and the substitute face read as visibly wrong — so both variants
 * now render the real artwork.
 *
 * The full lockup needs room to stay legible: at header sizes its wordmark
 * collapses to a few pixels, so prefer "flower" there and "full" only where the
 * layout can give it space.
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

  return (
    <Image
      source={full}
      style={{ width: size * FULL_ASPECT, height: size }}
      resizeMode="contain"
      accessibilityLabel="Emberly Apartments"
    />
  );
}

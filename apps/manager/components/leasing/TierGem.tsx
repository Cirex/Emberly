import Svg, { Circle, Path, Polygon } from "react-native-svg";

/**
 * The unit-tier gem that leads a pipeline row (approved artifact, frame 01).
 *
 * SHAPE CARRIES THE MEANING, colour only reinforces it: the four cuts are
 * distinguishable in greyscale, at a squint, and for a colour-blind manager —
 * brilliant (pointed), cushion (rounded), step (clipped corners), uncut
 * (circle). That is why the row spends 13px on a symbol instead of the tier
 * WORD it replaces: three of the four names are longer than the identity
 * block can hold next to a unit number.
 *
 * The tints are the artifact's, not CLASSIFICATION_TINT: the map palette is
 * tuned to sit on satellite imagery, and at 13px on a white row its ruby and
 * legacy read as the same brown.
 */
const GEM_TINT = {
  diamond: "#2E7BD6",
  ruby: "#C6303C",
  lux: "#B8912E",
  legacy: "#8A90A3",
} as const;

type GemCut = keyof typeof GEM_TINT;

/** Nothing was read — NOT a tier. See cutOf. */
const UNKNOWN_STROKE = "#C3C7D4";

/**
 * ResMan spells the classification free-form, and the mirror passes it
 * through untouched — so match loosely against the four tiers this property
 * uses (Ruby 390 · Legacy 240 · Diamond 226 · LUX 35 doors).
 *
 * Anything else returns null, and null is drawn as an EMPTY ring rather than
 * as a stone. Legacy must not be the fallback: it is a real tier on a quarter
 * of the property, so painting its grey circle for a lease whose unit is not
 * in the mirror (`row.tier === ""`) — or for a word ResMan invents tomorrow —
 * would state a classification nobody read. Same rule the derivation keeps
 * for unitObstacle: an unknown unit states nothing.
 */
function cutOf(tier: string): GemCut | null {
  const t = tier.trim().toLowerCase();
  if (t === "") return null;
  if (t.includes("diamond")) return "diamond";
  if (t.includes("ruby")) return "ruby";
  if (t.includes("lux")) return "lux";
  if (t.includes("legacy")) return "legacy";
  return null;
}

export function TierGem({ tier, size = 13 }: { tier: string; size?: number }) {
  const cut = cutOf(tier);
  if (cut === null) {
    // Hollow and dashed, so it reads as "no tier known" next to the four
    // filled stones — and still holds the 13px slot, keeping every unit
    // number on the board left-aligned with every other.
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle
          cx={12}
          cy={12}
          r={8}
          fill="none"
          stroke={UNKNOWN_STROKE}
          strokeWidth={1.5}
          strokeDasharray="3 2.5"
        />
      </Svg>
    );
  }
  const fill = GEM_TINT[cut];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {cut === "diamond" ? (
        <>
          {/* Brilliant cut: flat table, sloped crown, pavilion to a point. */}
          <Polygon points="7,4 17,4 21,10 12,21 3,10" fill={fill} />
          {/* The girdle + the two table facets — the cut's signature lines. */}
          <Path
            d="M3 10 H21 M7 4 L3 10 M17 4 L21 10"
            stroke="#FFFFFF"
            strokeWidth={1.1}
            strokeLinecap="round"
            fill="none"
          />
        </>
      ) : cut === "ruby" ? (
        // Cushion cut: a hexagon with every corner rounded off.
        <Polygon
          points="12,3 19,7.5 19,16.5 12,21 5,16.5 5,7.5"
          fill={fill}
          strokeWidth={3}
          stroke={fill}
          strokeLinejoin="round"
        />
      ) : cut === "lux" ? (
        <>
          {/* Emerald step cut: a rectangle with its four corners clipped. */}
          <Polygon points="8,3 16,3 21,8 21,16 16,21 8,21 3,16 3,8" fill={fill} />
          {/* One inset step, so it reads as terraced rather than as a blob. */}
          <Polygon
            points="9,6 15,6 18,9 18,15 15,18 9,18 6,15 6,9"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={1.1}
          />
        </>
      ) : (
        // Uncut stone: no facets to draw, so the circle says "no cut" plainly.
        <Circle cx={12} cy={12} r={8.5} fill={fill} />
      )}
    </Svg>
  );
}

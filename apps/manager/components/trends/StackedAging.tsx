import { Text, View } from "react-native";
import Svg, { Polygon } from "react-native-svg";
import { TREND_COLORS } from "@/components/trends/bits";

/**
 * The delinquency-by-age chart — the mockup's three translucent stacked
 * areas: 0–30 (green) over 31–90 (amber) over 90+ (red), all baselined at the
 * bottom of the box. Each layer's outline is a CUMULATIVE total (90+, then
 * +31–90, then +0–30 = the whole balance), painted back-to-front so the
 * overlaps produce the mockup's depth without any path clipping.
 */
const VIEW_W = 320;
const VIEW_H = 84;
const PAD_TOP = 8;

export const AGING_LAYER_COLORS = {
  b0030: "rgba(51,166,102,0.25)",
  b3190: "rgba(227,135,54,0.35)",
  b90: "rgba(209,56,46,0.4)",
} as const;

/** Legend swatches are the solid-ish variants the mockup uses. */
export const AGING_LEGEND_COLORS = {
  b0030: "rgba(51,166,102,0.5)",
  b3190: "rgba(227,135,54,0.6)",
  b90: "rgba(209,56,46,0.6)",
} as const;

export interface AgingPoint {
  /** 0–30-day balance. */
  b0030: number;
  /** 31–90-day balance (the 31–60 and 61–90 buckets folded, per the mockup). */
  b3190: number;
  /** 90+-day balance. */
  b90: number;
}

function areaPoints(values: number[], max: number): string {
  const top = values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * VIEW_W;
      const y = max === 0 ? VIEW_H : PAD_TOP + (1 - value / max) * (VIEW_H - PAD_TOP);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `0,${VIEW_H} ${top} ${VIEW_W},${VIEW_H}`;
}

export function StackedAging({
  points,
  height = 84,
  emptyLabel,
}: {
  /** Daily bucket totals, oldest first. */
  points: AgingPoint[];
  height?: number;
  /** Shown when fewer than two points exist. */
  emptyLabel?: string;
}) {
  if (points.length < 2) {
    return (
      <View style={{ height, alignItems: "center", justifyContent: "center" }}>
        {emptyLabel ? (
          <Text style={{ fontSize: 10.5, color: TREND_COLORS.muted }}>{emptyLabel}</Text>
        ) : null}
      </View>
    );
  }

  const c90 = points.map((p) => p.b90);
  const c3190 = points.map((p) => p.b90 + p.b3190);
  const cAll = points.map((p) => p.b90 + p.b3190 + p.b0030);
  const max = Math.max(...cAll, 0);

  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none">
      <Polygon points={areaPoints(cAll, max)} fill={AGING_LAYER_COLORS.b0030} />
      <Polygon points={areaPoints(c3190, max)} fill={AGING_LAYER_COLORS.b3190} />
      <Polygon points={areaPoints(c90, max)} fill={AGING_LAYER_COLORS.b90} />
    </Svg>
  );
}

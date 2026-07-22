import { Text, View } from "react-native";
import Svg, { Circle, Line, Polyline } from "react-native-svg";
import { TREND_COLORS } from "@/components/trends/bits";

/**
 * The big line chart of the Trends cards — the mockup's `.trendline`: a
 * 320×84 stretched viewBox, three faint horizontal gridlines, a 2.5px series
 * line, and a dot on the endpoint. Values are raw; the chart normalizes into
 * the box with a little vertical padding so peaks never kiss the border.
 *
 * Under two points there is nothing to draw a line THROUGH, so the chart
 * renders the caller's `emptyLabel` instead — the "series not yet begun"
 * face of the honest-backfill rule.
 */
const VIEW_W = 320;
const VIEW_H = 84;
const PAD_Y = 6;

export function TrendLine({
  points,
  tint,
  height = 84,
  emptyLabel,
}: {
  /** Daily values, oldest first (nulls already stripped by the caller). */
  points: number[];
  /** Stroke/dot color. */
  tint: string;
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

  const min = Math.min(...points);
  const max = Math.max(...points);
  const spread = max - min;
  const xy = (value: number, i: number): [number, number] => [
    (i / (points.length - 1)) * VIEW_W,
    spread === 0 ? VIEW_H / 2 : PAD_Y + (1 - (value - min) / spread) * (VIEW_H - PAD_Y * 2),
  ];
  const coords = points.map((v, i) => xy(v, i));
  const polyline = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const [endX, endY] = coords[coords.length - 1];

  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none">
      {[21, 42, 63].map((y) => (
        <Line key={y} x1={0} y1={y} x2={VIEW_W} y2={y} stroke="rgba(9,27,84,0.06)" strokeWidth={1} />
      ))}
      <Polyline points={polyline} fill="none" stroke={tint} strokeWidth={2.5} />
      <Circle cx={endX} cy={endY} r={3.5} fill={tint} />
    </Svg>
  );
}

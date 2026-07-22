import Svg, { Polyline } from "react-native-svg";
import { MIN_SPARK_POINTS } from "@/lib/derived/trends";

/**
 * Inline mini line chart for a KPI label — the mockup's `.spark` (42×12,
 * 1.5px stroke, no axes, no dots). Reusable anywhere a label wants a
 * thumbnail history: pass raw daily values and a tint.
 *
 * GATED per the mockup's "Sparklines appear once 14 days of snapshots exist":
 * under MIN_SPARK_POINTS points it renders nothing at all, so a days-old
 * snapshot table never draws a meaningless squiggle. (lib/derived/trends'
 * `sparkValues` applies the same gate at the data layer; this is the
 * belt-and-suspenders for direct callers.)
 */
export function Spark({
  points,
  tint,
  width = 42,
  height = 12,
}: {
  /** Daily values, oldest first. */
  points: number[];
  /** Stroke color (e.g. "#33A666"). */
  tint: string;
  width?: number;
  height?: number;
}) {
  if (points.length < MIN_SPARK_POINTS) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const spread = max - min;
  const padY = 1.5; // keep the stroke inside the box
  const coords = points
    .map((value, i) => {
      const x = (i / (points.length - 1)) * width;
      const y =
        spread === 0
          ? height / 2
          : padY + (1 - (value - min) / spread) * (height - padY * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Polyline points={coords} fill="none" stroke={tint} strokeWidth={1.5} />
    </Svg>
  );
}

import { Text, View } from "react-native";
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { CALLBACK_TINT, NAVY } from "@/theme/tokens";

/**
 * Hand-rolled static charts for the analytics overlays (react-native-svg —
 * already a dependency; no chart library). Four shapes, exactly what the Swift
 * panels used: line-with-target, bars, scatter, and the rate capsule.
 */

export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(value));
  const norm = value / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

const AXIS = "rgba(9,27,84,0.35)";
const GRID = "rgba(9,27,84,0.08)";

export interface LinePoint {
  x: number;
  y: number;
}

/** One series over evenly-indexed x (weeks); optional dashed target line. */
export function LineChart({
  points,
  color,
  height = 130,
  width = 560,
  targetY,
  formatY = (v) => String(v),
  formatX,
}: {
  points: LinePoint[];
  color: string;
  height?: number;
  width?: number;
  targetY?: number;
  formatY?: (v: number) => string;
  formatX?: (x: number, index: number) => string;
}) {
  const padL = 34;
  const padB = formatX ? 16 : 6;
  const padT = 8;
  const w = width - padL - 8;
  const h = height - padT - padB;
  const maxY = niceMax(Math.max(...points.map((p) => p.y), targetY ?? 0, 1));
  const px = (i: number) => padL + (points.length <= 1 ? w / 2 : (i / (points.length - 1)) * w);
  const py = (v: number) => padT + h - (v / maxY) * h;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");

  return (
    <Svg width={width} height={height}>
      {[0, 0.5, 1].map((f) => (
        <Line key={f} x1={padL} x2={padL + w} y1={py(maxY * f)} y2={py(maxY * f)} stroke={GRID} strokeWidth={1} />
      ))}
      {[0, 0.5, 1].map((f) => (
        <SvgText key={`l${f}`} x={padL - 5} y={py(maxY * f) + 3} fontSize={8.5} fill={AXIS} textAnchor="end">
          {formatY(maxY * f)}
        </SvgText>
      ))}
      {targetY !== undefined ? (
        <Line
          x1={padL}
          x2={padL + w}
          y1={py(targetY)}
          y2={py(targetY)}
          stroke={AXIS}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      ) : null}
      <Path d={path} stroke={color} strokeWidth={2} fill="none" />
      {points.map((p, i) => (
        <Circle key={i} cx={px(i)} cy={py(p.y)} r={2.6} fill={color} />
      ))}
      {formatX
        ? points.map((p, i) =>
            i % Math.ceil(points.length / 6) === 0 ? (
              <SvgText key={`x${i}`} x={px(i)} y={height - 3} fontSize={8} fill={AXIS} textAnchor="middle">
                {formatX(p.x, i)}
              </SvgText>
            ) : null,
          )
        : null}
    </Svg>
  );
}

export function BarChart({
  bars,
  color,
  height = 150,
  width = 560,
}: {
  bars: { label: string; value: number }[];
  color: string;
  height?: number;
  width?: number;
}) {
  const padB = 18;
  const padT = 14;
  const h = height - padT - padB;
  const maxV = niceMax(Math.max(...bars.map((b) => b.value), 1));
  const slot = width / bars.length;
  const barW = Math.min(slot * 0.55, 64);
  return (
    <Svg width={width} height={height}>
      {bars.map((b, i) => {
        const bh = (b.value / maxV) * h;
        const x = slot * i + (slot - barW) / 2;
        const y = padT + h - bh;
        return (
          <Rect key={b.label} x={x} y={y} width={barW} height={Math.max(bh, 2)} rx={8} fill={color} opacity={0.9} />
        );
      })}
      {bars.map((b, i) => (
        <SvgText
          key={`v${b.label}`}
          x={slot * i + slot / 2}
          y={padT + h - (b.value / maxV) * h - 4}
          fontSize={9.5}
          fontWeight="700"
          fill={NAVY}
          textAnchor="middle"
        >
          {b.value.toLocaleString()}
        </SvgText>
      ))}
      {bars.map((b, i) => (
        <SvgText
          key={`l${b.label}`}
          x={slot * i + slot / 2}
          y={height - 4}
          fontSize={9}
          fill={AXIS}
          textAnchor="middle"
        >
          {b.label}
        </SvgText>
      ))}
    </Svg>
  );
}

/** Volume-vs-rate scatter; bubble size ∝ size value; dashed target on y. */
export function ScatterChart({
  points,
  targetY,
  height = 150,
  width = 260,
  formatY = (v) => `${(v * 100).toFixed(0)}%`,
}: {
  points: { x: number; y: number; size: number; label: string }[];
  targetY?: number;
  height?: number;
  width?: number;
  formatY?: (v: number) => string;
}) {
  const padL = 34;
  const padB = 14;
  const padT = 8;
  const w = width - padL - 10;
  const h = height - padT - padB;
  const maxX = niceMax(Math.max(...points.map((p) => p.x), 1));
  const maxY = Math.max(...points.map((p) => p.y), targetY ?? 0, 0.01) * 1.2;
  const maxSize = Math.max(...points.map((p) => p.size), 1);
  const px = (v: number) => padL + (v / maxX) * w;
  const py = (v: number) => padT + h - (v / maxY) * h;
  return (
    <Svg width={width} height={height}>
      <Line x1={padL} x2={padL + w} y1={padT + h} y2={padT + h} stroke={GRID} strokeWidth={1} />
      {targetY !== undefined ? (
        <Line x1={padL} x2={padL + w} y1={py(targetY)} y2={py(targetY)} stroke={AXIS} strokeWidth={1} strokeDasharray="4 3" />
      ) : null}
      {[0.5, 1].map((f) => (
        <SvgText key={f} x={padL - 5} y={py(maxY * f) + 3} fontSize={8.5} fill={AXIS} textAnchor="end">
          {formatY(maxY * f)}
        </SvgText>
      ))}
      {points.map((p) => (
        <Circle
          key={p.label}
          cx={px(p.x)}
          cy={py(p.y)}
          r={4 + (p.size / maxSize) * 7}
          fill="#7A6BC7"
          opacity={0.55}
        />
      ))}
      {points.map((p) => (
        <SvgText key={`t${p.label}`} x={px(p.x)} y={py(p.y) - 8} fontSize={8} fill={CALLBACK_TINT} textAnchor="middle">
          {p.label}
        </SvgText>
      ))}
    </Svg>
  );
}


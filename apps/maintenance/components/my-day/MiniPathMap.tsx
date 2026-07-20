import {
  Canvas,
  Circle,
  DashPathEffect,
  Fill,
  Group,
  Path,
  Picture,
  Skia,
  Text as SkiaText,
  matchFont,
  useFont,
} from "@shopify/react-native-skia";
import { useColorScheme } from "nativewind";
import { useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { buildPlanPicture } from "@emberly/ui";
import { PAGE_HEIGHT, PAGE_WIDTH, PLACED_UNITS } from "@/lib/map-data";
import { OLIVE } from "@/theme/tokens";

/**
 * The path preview strip on My Day: a static, non-interactive slice of the
 * property plan fitted around the path's stops, with the numbered badges and
 * a dashed route line between them in order. Tap handling lives on the parent
 * (it jumps to the Map tab) — this only paints.
 */

const DONE = "#33A666";
const EMERGENCY = "#D1382E";
const BADGE_R = 11; // screen points — the canvas is unzoomable, so fixed size

const IONICONS_TTF = require("@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const IONICONS_GLYPHS: Record<string, number> = require("@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json");

const UNIT_CENTER = new Map(PLACED_UNITS.map((u) => [u.number, u]));

export interface MiniPathStop {
  unitNumber: string;
  isDone: boolean;
  isEmergency: boolean;
}

export function MiniPathMap({
  stops,
  height = 150,
  radius = 14,
}: {
  stops: MiniPathStop[];
  /** Strip height in points; My Day's full-bleed hero runs taller. */
  height?: number;
  /** 0 for the edge-to-edge hero — the strip loses its rounded container. */
  radius?: number;
}) {
  const HEIGHT = height;
  const dark = useColorScheme().colorScheme === "dark";
  const [width, setWidth] = useState(0);
  const plan = useMemo(() => buildPlanPicture(dark), [dark]);
  const checkFont = useFont(IONICONS_TTF, 12);
  const numberFont = useMemo(
    () =>
      matchFont({
        fontFamily: Platform.select({ ios: "Helvetica Neue", default: "sans-serif" }),
        fontSize: 11,
        fontWeight: "bold",
      }),
    [],
  );

  const placed = stops
    .map((s) => ({ ...s, center: UNIT_CENTER.get(s.unitNumber) }))
    .filter((s) => s.center !== undefined) as (MiniPathStop & {
    center: { cx: number; cy: number };
  })[];

  // Fit the viewport around the stops (whole plan when there are none).
  const view = useMemo(() => {
    if (width <= 0) return null;
    let minX = 0;
    let minY = 0;
    let maxX = PAGE_WIDTH;
    let maxY = PAGE_HEIGHT;
    if (placed.length > 0) {
      minX = Math.min(...placed.map((s) => s.center.cx));
      maxX = Math.max(...placed.map((s) => s.center.cx));
      minY = Math.min(...placed.map((s) => s.center.cy));
      maxY = Math.max(...placed.map((s) => s.center.cy));
    }
    // Generous padding so badges never kiss the edges; enforce a minimum
    // window so a single stop doesn't zoom into a wall.
    const PAD = 260;
    minX -= PAD;
    maxX += PAD;
    minY -= PAD;
    maxY += PAD;
    const MIN_SPAN = 1400;
    if (maxX - minX < MIN_SPAN) {
      const cx = (minX + maxX) / 2;
      minX = cx - MIN_SPAN / 2;
      maxX = cx + MIN_SPAN / 2;
    }
    if (maxY - minY < MIN_SPAN * (HEIGHT / Math.max(width, 1))) {
      const cy = (minY + maxY) / 2;
      const half = (MIN_SPAN * (HEIGHT / Math.max(width, 1))) / 2;
      minY = cy - half;
      maxY = cy + half;
    }
    const scale = Math.min(width / (maxX - minX), HEIGHT / (maxY - minY));
    const tx = (width - (maxX - minX) * scale) / 2 - minX * scale;
    const ty = (HEIGHT - (maxY - minY) * scale) / 2 - minY * scale;
    return { scale, tx, ty };
  }, [width, placed]);

  // Dashed route through the stops in path order (screen space).
  const routePath = useMemo(() => {
    if (!view || placed.length < 2) return null;
    const b = Skia.PathBuilder.Make();
    placed.forEach((s, i) => {
      const x = s.center.cx * view.scale + view.tx;
      const y = s.center.cy * view.scale + view.ty;
      if (i === 0) b.moveTo(x, y);
      else b.lineTo(x, y);
    });
    return b.detach();
  }, [view, placed]);

  return (
    <View
      style={{ height: HEIGHT, borderRadius: radius, overflow: "hidden" }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      pointerEvents="none"
    >
      {view ? (
        <Canvas style={{ width, height: HEIGHT }}>
          {/* Ground fill so the fitted plan slice reads as a full-bleed strip. */}
          <Fill color={dark ? "#18211C" : "#C3D9B4"} />
          <Group transform={[{ translateX: view.tx }, { translateY: view.ty }, { scale: view.scale }]}>
            <Picture picture={plan} />
          </Group>
          {routePath ? (
            <Path path={routePath} style="stroke" strokeWidth={2} color="rgba(132,143,13,0.75)">
              <DashPathEffect intervals={[6, 5]} />
            </Path>
          ) : null}
          {placed.map((s, i) => {
            const x = s.center.cx * view.scale + view.tx;
            const y = s.center.cy * view.scale + view.ty;
            const fill = s.isDone ? DONE : s.isEmergency ? EMERGENCY : OLIVE;
            const label = s.isDone
              ? String.fromCodePoint(IONICONS_GLYPHS["checkmark"])
              : s.isEmergency
                ? "!"
                : `${i + 1}`;
            const font = s.isDone ? checkFont : numberFont;
            const size = s.isDone ? 12 : 11;
            const labelW = font ? font.getTextWidth(label) : 0;
            return (
              <Group key={s.unitNumber}>
                <Circle cx={x} cy={y} r={BADGE_R} color={fill} />
                <Circle cx={x} cy={y} r={BADGE_R} color="rgba(255,255,255,0.9)" style="stroke" strokeWidth={1.6} />
                {font ? (
                  <SkiaText x={x - labelW / 2} y={y + size * 0.36} text={label} font={font} color="#FFFFFF" />
                ) : null}
              </Group>
            );
          })}
        </Canvas>
      ) : null}
    </View>
  );
}

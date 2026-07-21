import {
  Canvas,
  Circle,
  DashPathEffect,
  Fill,
  Group,
  Path,
  Picture,
  Rect,
  RoundedRect,
  Skia,
  rect,
  rrect,
} from "@shopify/react-native-skia";
import { useColorScheme } from "nativewind";
import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { RectColor } from "@emberly/core";
import { MUTED } from "@/theme/tokens";
import {
  BLOCK_RADIUS,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PLACED_BLOCKS,
  PLACED_UNITS,
  UNIT_BLOCK,
  type PlacedUnit,
} from "@/components/map/map-data";
import { buildPlanPicture } from "@emberly/ui";

/**
 * The shared Skia property map, manager cut — a READ lens over the plan.
 * Ported from the maintenance app's components/map/SkiaMapCanvas.tsx: same
 * recorded-picture plan, unit tint layer, pan/pinch/tap gesture arbitration,
 * clamped camera, selection highlight and anchored callout. Trimmed of
 * everything the manager doesn't do on the map in v1: annotation pins and
 * placement modes, utility runs/draw, tour badges.
 */

const FADED_FILL = "rgba(9,27,84,0.035)";
const MATCH_FILL = "rgba(162,169,33,0.62)";
const MIN_SCALE = 1;
const MAX_SCALE = 12;
/** Opening zoom — the manager reads the property whole, so it opens at the
 *  3× overview level (security's posture) rather than maintenance's 8×
 *  close-up on the leasing office. */
const DEFAULT_ZOOM = 3;

/** Corner radius on the selection highlight — soft, matching the building cards. */
const SEL_RADIUS = 4;
/** Inset the highlight border off the building edge so the block clip can't
 *  shave the half of the stroke that would otherwise straddle the boundary. */
const SEL_INSET = 2;

/** Callout card footprint used for placement (content sizes itself within). */
const TIP_W = 250;
const TIP_H = 205;
const TIP_PAD = 8;

interface TooltipPlacement {
  left: number;
  top: number;
  sx: number;
  sy: number;
  mx: number;
  my: number;
  hasElbow: boolean;
  ex: number;
  ey: number;
}

/**
 * Swift's tooltipPlacement(), verbatim in spirit: 12 candidate positions
 * (4 axial, 4 corner-offset, 4 true-45° rays) sorted by available space,
 * first that fully fits wins, else the least-overflowing one — and always
 * clamped inside the viewport, so the card can never leave the screen
 * however small it is. The connector exits the card edge facing the unit,
 * with an L-elbow unless the two are nearly axis-aligned.
 */
function placeTooltip(
  ux: number,
  uy: number,
  uw: number,
  uh: number,
  vw: number,
  vh: number,
): TooltipPlacement {
  "worklet";
  const halfW = TIP_W / 2;
  const halfH = TIP_H / 2;
  const gap = 16;
  const pad = TIP_PAD;
  const minX = pad;
  const minY = pad;
  const maxX = vw - pad;
  const maxY = vh - pad;
  const cx = ux + uw / 2;
  const cy = uy + uh / 2;

  const spaceRight = maxX - (ux + uw);
  const spaceLeft = ux - minX;
  const spaceBelow = maxY - (uy + uh);
  const spaceAbove = uy - minY;
  const d45 = (Math.max(uw, uh) * 0.5 + gap) / Math.SQRT2;

  const candidates: { x: number; y: number; space: number }[] = [
    { x: ux + uw + gap + halfW, y: cy, space: spaceRight },
    { x: ux - gap - halfW, y: cy, space: spaceLeft },
    { x: cx, y: uy + uh + gap + halfH, space: spaceBelow },
    { x: cx, y: uy - gap - halfH, space: spaceAbove },
    { x: ux + uw + gap + halfW, y: uy + uh + gap + halfH, space: spaceRight + spaceBelow },
    { x: ux - gap - halfW, y: uy + uh + gap + halfH, space: spaceLeft + spaceBelow },
    { x: ux + uw + gap + halfW, y: uy - gap - halfH, space: spaceRight + spaceAbove },
    { x: ux - gap - halfW, y: uy - gap - halfH, space: spaceLeft + spaceAbove },
    { x: cx + d45 + halfW, y: cy + d45 + halfH, space: spaceRight + spaceBelow },
    { x: cx - d45 - halfW, y: cy + d45 + halfH, space: spaceLeft + spaceBelow },
    { x: cx + d45 + halfW, y: cy - d45 - halfH, space: spaceRight + spaceAbove },
    { x: cx - d45 - halfW, y: cy - d45 - halfH, space: spaceLeft + spaceAbove },
  ].sort((a, b) => b.space - a.space);

  const overflow = (x: number, y: number) => {
    const ox = Math.max(0, minX - (x - halfW)) + Math.max(0, x + halfW - maxX);
    const oy = Math.max(0, minY - (y - halfH)) + Math.max(0, y + halfH - maxY);
    return ox + oy;
  };

  let best = candidates[0];
  let bestOverflow = overflow(best.x, best.y);
  for (const c of candidates) {
    const o = overflow(c.x, c.y);
    if (o === 0) {
      best = c;
      bestOverflow = 0;
      break;
    }
    if (o < bestOverflow) {
      best = c;
      bestOverflow = o;
    }
  }

  const centerX = Math.min(Math.max(best.x, minX + halfW), Math.max(minX + halfW, maxX - halfW));
  const centerY = Math.min(Math.max(best.y, minY + halfH), Math.max(minY + halfH, maxY - halfH));

  // Connector: exit the card edge that faces the unit most directly.
  const dx = cx - centerX;
  const dy = cy - centerY;
  const exitHorizontal = Math.abs(dx) / TIP_W >= Math.abs(dy) / TIP_H;
  const sx = exitHorizontal ? (dx >= 0 ? centerX + halfW : centerX - halfW) : centerX;
  const sy = exitHorizontal ? centerY : dy >= 0 ? centerY + halfH : centerY - halfH;

  const straightTol = 8;
  const aligned = Math.abs(sx - cx) < straightTol || Math.abs(sy - cy) < straightTol;
  const mx = exitHorizontal ? cx : sx;
  const my = exitHorizontal ? sy : cy;

  return {
    left: centerX - halfW,
    top: centerY - halfH,
    sx,
    sy,
    mx,
    my,
    hasElbow: !aligned,
    ex: cx,
    ey: cy,
  };
}

interface UnitsLayerProps {
  matched: Set<string>;
  hasQuery: boolean;
  colorMap: Map<string, RectColor>;
}

const UnitsLayer = memo(function UnitsLayer({ matched, hasQuery, colorMap }: UnitsLayerProps) {
  // Tints clip to their building card so corner units follow the card's
  // rounded contour instead of drawing square shoulders over it. Grouping by
  // block keeps it to one clip per building rather than one per unit. The
  // plan is always drawn underneath, so an untinted unit needs no veil.
  const fills: { u: PlacedUnit; fill: string }[][] = PLACED_BLOCKS.map(() => []);
  const orphans: { u: PlacedUnit; fill: string }[] = [];
  for (const u of PLACED_UNITS) {
    const c = colorMap.get(u.number);
    const fill = matched.has(u.number) ? MATCH_FILL : hasQuery ? FADED_FILL : c?.fill;
    if (!fill) continue;
    const idx = UNIT_BLOCK.get(u.number);
    if (idx == null) orphans.push({ u, fill });
    else fills[idx].push({ u, fill });
  }
  return (
    <Group>
      {fills.map((list, i) => {
        if (list.length === 0) return null;
        const b = PLACED_BLOCKS[i];
        return (
          <Group key={i} clip={rrect(rect(b.x, b.y, b.w, b.h), BLOCK_RADIUS, BLOCK_RADIUS)}>
            {list.map(({ u, fill }) => (
              <Rect key={u.number} x={u.x} y={u.y} width={u.w} height={u.h} color={fill} />
            ))}
          </Group>
        );
      })}
      {orphans.map(({ u, fill }) => (
        <Rect key={u.number} x={u.x} y={u.y} width={u.w} height={u.h} color={fill} />
      ))}
    </Group>
  );
});

/** The rounded card shape of a unit's building, for clipping overlays. */
function blockClip(unitNumber: string) {
  const idx = UNIT_BLOCK.get(unitNumber);
  const b = idx == null ? undefined : PLACED_BLOCKS[idx];
  return b ? rrect(rect(b.x, b.y, b.w, b.h), BLOCK_RADIUS, BLOCK_RADIUS) : undefined;
}

interface SkiaMapCanvasProps {
  width: number;
  height: number;
  colorMap: Map<string, RectColor>;
  matched: Set<string>;
  hasQuery: boolean;
  selected?: PlacedUnit;
  /** Tint of the selected unit — drives highlight + connector. */
  selectedTint?: string;
  /** Rendered as a callout anchored at the selected unit, tracking pan/zoom. */
  tooltip?: ReactNode;
  /** Page point the map opens centered on (defaults to the page center). */
  home?: { x: number; y: number };
  /** Fly-to request: center this page point at DEFAULT_ZOOM. seq bumps per request. */
  focus?: { x: number; y: number; seq: number };
  onSelect: (number: string) => void;
}

export function SkiaMapCanvas({
  width,
  height,
  colorMap,
  matched,
  hasQuery,
  selected,
  selectedTint,
  home,
  focus,
  tooltip,
  onSelect,
}: SkiaMapCanvasProps) {
  const dark = useColorScheme().colorScheme === "dark";

  // Recorded once per scheme; replayed as vectors under the zoom transform
  // every frame. The night variant re-colors every op (see plan-picture.ts)
  // instead of dimming the daylight one under a veil.
  const plan = useMemo(() => buildPlanPicture(dark), [dark]);
  const baseScale = width / PAGE_WIDTH;

  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const pStartScale = useSharedValue(1);
  const pStartTx = useSharedValue(0);
  const pStartTy = useSharedValue(0);
  const pFocalX = useSharedValue(0);
  const pFocalY = useSharedValue(0);
  const panStartTx = useSharedValue(0);
  const panStartTy = useSharedValue(0);

  /** JS-side twin of the worklet clamp, for computing animation targets. */
  const clampPanJS = useCallback(
    (x: number, y: number, eff: number) => {
      const w = PAGE_WIDTH * eff;
      const h = PAGE_HEIGHT * eff;
      // Half a viewport of vertical slack: the map's top edge can be pulled
      // down to the screen center (and the bottom edge up to it), so edge
      // units are reachable under the floating chrome. Still hard-bounded.
      const slackY = height / 2;
      return {
        x: Math.min(Math.max(x, Math.min(0, width - w)), Math.max(0, width - w)),
        y: Math.min(Math.max(y, Math.min(0, height - h) - slackY), Math.max(0, height - h) + slackY),
      };
    },
    [width, height],
  );

  // Open at the working zoom, centered on home (page center by default).
  const zoomInitialized = useRef(false);
  useEffect(() => {
    if (zoomInitialized.current || width <= 0 || height <= 0) return;
    zoomInitialized.current = true;
    const eff = baseScale * DEFAULT_ZOOM;
    const hx = home?.x ?? PAGE_WIDTH / 2;
    const hy = home?.y ?? PAGE_HEIGHT / 2;
    scale.value = DEFAULT_ZOOM;
    const p = clampPanJS(width / 2 - hx * eff, height / 2 - hy * eff, eff);
    tx.value = p.x;
    ty.value = p.y;
  }, [width, height, baseScale, scale, tx, ty, home, clampPanJS]);

  // "View on Map": glide to the requested unit at the working zoom.
  const lastFocusSeq = useRef(0);
  useEffect(() => {
    if (!focus || focus.seq === lastFocusSeq.current || width <= 0) return;
    lastFocusSeq.current = focus.seq;
    const eff = baseScale * DEFAULT_ZOOM;
    const p = clampPanJS(width / 2 - focus.x * eff, height / 2 - focus.y * eff, eff);
    const glide = { duration: 450 };
    scale.value = withTiming(DEFAULT_ZOOM, glide);
    tx.value = withTiming(p.x, glide);
    ty.value = withTiming(p.y, glide);
  }, [focus, width, height, baseScale, scale, tx, ty, clampPanJS]);

  const transform = useDerivedValue(() => [
    { translateX: tx.value },
    { translateY: ty.value },
    { scale: scale.value * baseScale },
  ]);

  /**
   * Keep the page on screen: when the map is larger than the viewport the
   * translation stays within [viewport - map, 0]; when smaller, within
   * [0, gap] — either way it can never be flung out of view.
   */
  function clampPan(x: number, y: number, eff: number): { x: number; y: number } {
    "worklet";
    const w = PAGE_WIDTH * eff;
    const h = PAGE_HEIGHT * eff;
    // Same vertical slack as clampPanJS: top/bottom edges may reach the
    // screen center so edge units clear the floating chrome.
    const slackY = height / 2;
    const loX = Math.min(0, width - w);
    const hiX = Math.max(0, width - w);
    const loY = Math.min(0, height - h) - slackY;
    const hiY = Math.max(0, height - h) + slackY;
    return {
      x: Math.min(Math.max(x, loX), hiX),
      y: Math.min(Math.max(y, loY), hiY),
    };
  }

  const handleTap = (px: number, py: number) => {
    const eff = scale.value * baseScale;
    const wx = (px - tx.value) / eff;
    const wy = (py - ty.value) / eff;
    const hit = PLACED_UNITS.find((u) => wx >= u.x && wx <= u.x + u.w && wy >= u.y && wy <= u.y + u.h);
    // Tap-away clears the selection, like the Swift map — "" means none.
    onSelect(hit ? hit.number : "");
  };
  const tapRef = useRef(handleTap);
  tapRef.current = handleTap;
  const onTapJS = useCallback((px: number, py: number) => tapRef.current(px, py), []);

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onBegin((e) => {
        "worklet";
        pStartScale.value = scale.value;
        pStartTx.value = tx.value;
        pStartTy.value = ty.value;
        pFocalX.value = e.focalX;
        pFocalY.value = e.focalY;
      })
      .onUpdate((e) => {
        "worklet";
        const effOld = pStartScale.value * baseScale;
        const wx = (pFocalX.value - pStartTx.value) / effOld;
        const wy = (pFocalY.value - pStartTy.value) / effOld;
        const next = Math.min(Math.max(pStartScale.value * e.scale, MIN_SCALE), MAX_SCALE);
        const effNew = next * baseScale;
        scale.value = next;
        const p = clampPan(pFocalX.value - wx * effNew, pFocalY.value - wy * effNew, effNew);
        tx.value = p.x;
        ty.value = p.y;
      });

    const pan = Gesture.Pan()
      .onBegin(() => {
        "worklet";
        panStartTx.value = tx.value;
        panStartTy.value = ty.value;
      })
      .onUpdate((e) => {
        "worklet";
        const p = clampPan(
          panStartTx.value + e.translationX,
          panStartTy.value + e.translationY,
          scale.value * baseScale,
        );
        tx.value = p.x;
        ty.value = p.y;
      });

    // maxDistance kills the false-click class outright: any finger travel past
    // 10px is navigation, so the tap cancels instead of firing on release.
    const tap = Gesture.Tap()
      .maxDuration(260)
      .maxDistance(10)
      .onEnd((e) => {
        "worklet";
        runOnJS(onTapJS)(e.x, e.y);
      });

    // Exclusive: the tap only claims the touch when the nav gestures FAIL —
    // running it Simultaneous with pan/pinch made every short navigation flick
    // also select whatever was under the finger (the false-click complaint).
    return Gesture.Exclusive(Gesture.Simultaneous(pan, pinch), tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTapJS, baseScale]);

  // Everything about the callout — card position, connector route, terminal
  // dot — comes from one placement pass per frame, so the three can't drift.
  const placement = useDerivedValue<TooltipPlacement | null>(() => {
    if (!selected) return null;
    const eff = scale.value * baseScale;
    return placeTooltip(
      tx.value + selected.x * eff,
      ty.value + selected.y * eff,
      selected.w * eff,
      selected.h * eff,
      width,
      height,
    );
  }, [selected, baseScale, width, height]);

  const tooltipStyle = useAnimatedStyle(() => {
    const p = placement.value;
    if (!p) return { opacity: 0 };
    return { opacity: 1, left: p.left, top: p.top };
  }, [placement]);

  const connectorPath = useDerivedValue(() => {
    const b = Skia.PathBuilder.Make();
    const p = placement.value;
    if (!p) return b.detach();
    b.moveTo(p.sx, p.sy);
    if (p.hasElbow) b.lineTo(p.mx, p.my);
    b.lineTo(p.ex, p.ey);
    return b.detach();
  }, [placement]);

  const connectorDotX = useDerivedValue(() => placement.value?.ex ?? -100, [placement]);
  const connectorDotY = useDerivedValue(() => placement.value?.ey ?? -100, [placement]);

  // Swift draws the highlight at 1.6 screen points whatever the zoom; inside
  // the transformed group that means dividing by the effective scale.
  const highlightStroke = useDerivedValue(() => 1.6 / (scale.value * baseScale), [baseScale]);

  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={gesture}>
        <Canvas style={{ width, height }}>
          {/* The canvas floor — what shows beyond the page edges. */}
          <Fill color={dark ? "#101318" : "#F6F4EB"} />
          <Group transform={transform}>
            <Picture picture={plan} />
            <UnitsLayer matched={matched} hasQuery={hasQuery} colorMap={colorMap} />

            {/* Selection highlight: the unit's lens tint at 18% with a
                hairline. Rounded corners (and clipped to the building card) so
                it follows the soft contour instead of laying a hard square box
                over a rounded unit. */}
            {selected ? (
              <Group clip={blockClip(selected.number)}>
                <Rect
                  x={selected.x}
                  y={selected.y}
                  width={selected.w}
                  height={selected.h}
                  color={selectedTint ?? MUTED}
                  opacity={0.18}
                />
                {/* Border inset off the cell edge so the clip can't shave it. */}
                <RoundedRect
                  rect={rrect(
                    rect(
                      selected.x + SEL_INSET,
                      selected.y + SEL_INSET,
                      selected.w - SEL_INSET * 2,
                      selected.h - SEL_INSET * 2,
                    ),
                    SEL_RADIUS,
                    SEL_RADIUS,
                  )}
                  color={selectedTint ?? MUTED}
                  style="stroke"
                  strokeWidth={highlightStroke}
                />
              </Group>
            ) : null}
          </Group>

          {/* Connector between card and unit — screen space, so the dashes
              stay 1.5pt at every zoom (Swift drew this the same way). */}
          {selected && tooltip ? (
            <>
              <Path
                path={connectorPath}
                style="stroke"
                strokeWidth={1.5}
                strokeCap="round"
                color={selectedTint ?? MUTED}
                opacity={0.65}
              >
                <DashPathEffect intervals={[5, 3.5]} />
              </Path>
              <Circle cx={connectorDotX} cy={connectorDotY} r={3.5} color={selectedTint ?? MUTED} />
            </>
          ) : null}
        </Canvas>
      </GestureDetector>

      {/* Outside the GestureDetector so its own controls receive touches
          instead of the canvas tap hit-testing units underneath the card. */}
      {selected && tooltip ? (
        <Animated.View style={[{ position: "absolute", width: TIP_W }, tooltipStyle]}>{tooltip}</Animated.View>
      ) : null}
    </View>
  );
}

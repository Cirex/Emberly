import { Ionicons } from "@expo/vector-icons";
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
  Text as SkiaText,
  matchFont,
  rect,
  rrect,
  useFont,
} from "@shopify/react-native-skia";
import { useColorScheme } from "nativewind";
import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { RectColor } from "@emberly/core";
import { MUTED, OLIVE } from "@/theme/tokens";
import {
  BLOCK_RADIUS,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PLACED_BLOCKS,
  PLACED_UNITS,
  UNIT_BLOCK,
  type PlacedUnit,
} from "@/lib/map-data";
import type { MapAnnotation } from "@/lib/stores/annotations";
import { buildPlanPicture } from "@emberly/ui";

const DEFAULT_FILL = "rgba(9,27,84,0.10)";
const FADED_FILL = "rgba(9,27,84,0.035)";
const MATCH_FILL = "rgba(162,169,33,0.62)";
const MIN_SCALE = 1;
const MAX_SCALE = 12;
/** Opening zoom — maintenance works close-up: 8× on the leasing office
 *  (3613 KG-1), deeper than security's 3× overview level. */
const DEFAULT_ZOOM = 8;

// Marker sizes in page units. The page is the 5347-wide unitmap canvas, so
// on-screen size at fit-width ≈ value / 4.5 pt on an 11" iPad.
const PIN_R = 22;
/** Corner radius on the selection highlight — soft, matching the building cards. */
const SEL_RADIUS = 4;
/** Inset the highlight border off the building edge so the block clip can't
 *  shave the half of the stroke that would otherwise straddle the boundary. */
const SEL_INSET = 2;
/** Squared tap radius (~63 page px ≈ 14 pt on screen at fit). */
const HIT_R2 = 4000;

/** Ionicons rendered straight onto the pins via the bundled typeface. */
const IONICONS_TTF = require("@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const IONICONS_GLYPHS: Record<string, number> = require("@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json");
const PIN_ICON_SIZE = 26;

function pinGlyph(name: string | undefined): string {
  const code = IONICONS_GLYPHS[name || "document-text"] ?? IONICONS_GLYPHS["document-text"];
  return String.fromCodePoint(code);
}

// Tour badges live in page space like the annotation pins, so they scale with
// the map. Sized up from the original 8-unit radius — the smaller discs were
// hard to pick out against the plan.
const TOUR_BADGE_R = 14;
const TOUR_NUM_SIZE = 15;
const TOUR_CHECK_SIZE = 16;
const TOUR_DONE = "#33A666";
// The dashed route threading the stops in order, drawn under the badges.
const TOUR_ROUTE_COLOR = "rgba(132,143,13,0.92)";
const TOUR_ROUTE_WIDTH = 4;

/** Page-space centroid per unit, for placing tour badges. */
const TOUR_UNIT_CENTER = new Map(PLACED_UNITS.map((u) => [u.number, u]));

/** A stop the canvas needs to badge — the store's TourStop satisfies this. */
export interface TourBadgeStop {
  unitNumber: string;
  isDone: boolean;
}

/** Tooltip card footprint used for placement (content sizes itself within).
    Width matches the Swift card (286 content + padding). */
const TIP_W = 250;
const TIP_H = 205;
const TIP_GAP = 12;
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

export type PlaceMode = "none" | "annotate";

interface UnitsLayerProps {
  matched: Set<string>;
  hasQuery: boolean;
  colorMap: Map<string, RectColor>;
  showPlan: boolean;
}

/** The rounded card shape of a unit's building, for clipping overlays. */
function blockClip(unitNumber: string) {
  const idx = UNIT_BLOCK.get(unitNumber);
  const b = idx == null ? undefined : PLACED_BLOCKS[idx];
  return b ? rrect(rect(b.x, b.y, b.w, b.h), BLOCK_RADIUS, BLOCK_RADIUS) : undefined;
}

const UnitsLayer = memo(function UnitsLayer({ matched, hasQuery, colorMap, showPlan }: UnitsLayerProps) {
  // Tints clip to their building card so corner units follow the card's
  // rounded contour instead of drawing square shoulders over it. Grouping by
  // block keeps it to one clip per building rather than one per unit.
  const fills: Array<{ u: PlacedUnit; fill: string }[]> = PLACED_BLOCKS.map(() => []);
  const orphans: Array<{ u: PlacedUnit; fill: string }> = [];
  for (const u of PLACED_UNITS) {
    const c = colorMap.get(u.number);
    // Over the drawn plan an untinted unit needs no veil — the card is the
    // visual. The flat navy default only earns its place when the plan is
    // hidden and the boxes are all there is to see.
    const fill = matched.has(u.number)
      ? MATCH_FILL
      : hasQuery
        ? FADED_FILL
        : (c?.fill ?? (showPlan ? undefined : DEFAULT_FILL));
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

interface SkiaMapCanvasProps {
  width: number;
  height: number;
  colorMap: Map<string, RectColor>;
  matched: Set<string>;
  hasQuery: boolean;
  selected?: PlacedUnit;
  /** Occupancy tint of the selected unit — drives highlight + connector. */
  selectedTint?: string;
  annotations: MapAnnotation[];
  /** Tour stops, in route order — each gets a numbered badge at its unit. */
  tourStops?: TourBadgeStop[];
  night: boolean;
  placeMode: PlaceMode;
  showPlan: boolean;
  /** Rendered as a callout anchored at the selected unit, tracking pan/zoom. */
  tooltip?: ReactNode;
  /** Page point the map opens centered on (defaults to the page center). */
  home?: { x: number; y: number };
  /** Fly-to request: center this page point at DEFAULT_ZOOM. seq bumps per request. */
  focus?: { x: number; y: number; seq: number };
  onSelect: (number: string) => void;
  onPlacePin: (nx: number, ny: number) => void;
  onSelectPin: (id: string) => void;
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
  annotations,
  tourStops,
  night,
  placeMode,
  showPlan,
  tooltip,
  onSelect,
  onPlacePin,
  onSelectPin,
}: SkiaMapCanvasProps) {
  const dark = useColorScheme().colorScheme === "dark";
  const pinIconFont = useFont(IONICONS_TTF, PIN_ICON_SIZE);
  // Ionicons checkmark for done badges (system fonts may lack U+2713);
  // stop numbers use the system face via matchFont.
  const tourCheckFont = useFont(IONICONS_TTF, TOUR_CHECK_SIZE);
  const tourNumberFont = useMemo(
    () =>
      matchFont({
        fontFamily: Platform.select({ ios: "Helvetica Neue", default: "sans-serif" }),
        fontSize: TOUR_NUM_SIZE,
        fontWeight: "bold",
      }),
    [],
  );
  // The dashed route threading the tour stops in order (page space, so it sits
  // under the badges and scales with them). Null until there are two placed
  // stops to connect.
  const tourRoutePath = useMemo(() => {
    if (!tourStops || tourStops.length < 2) return null;
    const b = Skia.PathBuilder.Make();
    let started = false;
    for (const s of tourStops) {
      const u = TOUR_UNIT_CENTER.get(s.unitNumber);
      if (!u) continue;
      if (!started) {
        b.moveTo(u.cx, u.cy);
        started = true;
      } else {
        b.lineTo(u.cx, u.cy);
      }
    }
    return started ? b.detach() : null;
  }, [tourStops]);

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
      return {
        x: Math.min(Math.max(x, Math.min(0, width - w)), Math.max(0, width - w)),
        y: Math.min(Math.max(y, Math.min(0, height - h)), Math.max(0, height - h)),
      };
    },
    [width, height],
  );

  // Open at the Swift app's working zoom, centered on home (the leasing
  // office by default) rather than the abstract page center.
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
    const loX = Math.min(0, width - w);
    const hiX = Math.max(0, width - w);
    const loY = Math.min(0, height - h);
    const hiY = Math.max(0, height - h);
    return {
      x: Math.min(Math.max(x, loX), hiX),
      y: Math.min(Math.max(y, loY), hiY),
    };
  }

  const handleTap = (px: number, py: number) => {
    const eff = scale.value * baseScale;
    const wx = (px - tx.value) / eff;
    const wy = (py - ty.value) / eff;

    if (placeMode === "annotate") return onPlacePin(wx / PAGE_WIDTH, wy / PAGE_HEIGHT);

    for (const a of annotations) {
      const dx = wx - a.x * PAGE_WIDTH;
      const dy = wy - a.y * PAGE_HEIGHT;
      if (dx * dx + dy * dy <= HIT_R2) return onSelectPin(a.id);
    }
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
          {showPlan ? <Picture picture={plan} /> : null}
          <UnitsLayer matched={matched} hasQuery={hasQuery} colorMap={colorMap} showPlan={showPlan} />

          {/* Selection highlight: the unit's occupancy tint at 18% with a
              hairline. Rounded corners (and clipped to the building card) so it
              follows the soft contour instead of laying a hard square box over
              a rounded unit — matches how the occupancy tint reads. */}
          {selected ? (
            <Group clip={blockClip(selected.number)}>
              {/* Tint fills the whole cell; the block clip rounds any outer
                  corner so it reads like the occupancy fill. */}
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
          {/* Pins: colored disc, white ring, and the pin's chosen Ionicons
              glyph (note, unlocked door, trash, …) drawn with the real font. */}
          {annotations.map((a) => {
            const cx = a.x * PAGE_WIDTH;
            const cy = a.y * PAGE_HEIGHT;
            const glyph = pinGlyph(a.icon);
            const glyphW = pinIconFont ? pinIconFont.getTextWidth(glyph) : 0;
            return (
              <Group key={a.id}>
                <Circle cx={cx} cy={cy} r={PIN_R} color={a.color} />
                <Circle cx={cx} cy={cy} r={PIN_R} color="rgba(255,255,255,0.85)" style="stroke" strokeWidth={3.4} />
                {pinIconFont ? (
                  <SkiaText
                    x={cx - glyphW / 2}
                    y={cy + PIN_ICON_SIZE * 0.36}
                    text={glyph}
                    font={pinIconFont}
                    color="#FFFFFF"
                  />
                ) : (
                  <>
                    <Rect x={cx - 9} y={cy - 6} width={18} height={3.6} color="#FFFFFF" />
                    <Rect x={cx - 9} y={cy + 2.4} width={12} height={3.6} color="#FFFFFF" />
                  </>
                )}
              </Group>
            );
          })}

          {/* The route line first, so the numbered discs sit on top of it. */}
          {tourRoutePath ? (
            <Path
              path={tourRoutePath}
              style="stroke"
              strokeWidth={TOUR_ROUTE_WIDTH}
              strokeCap="round"
              strokeJoin="round"
              color={TOUR_ROUTE_COLOR}
            >
              <DashPathEffect intervals={[TOUR_BADGE_R, TOUR_BADGE_R * 0.7]} />
            </Path>
          ) : null}

          {/* Tour route badges (TourRouteMapOverlayLayout.swift): a numbered
              disc at each stop's unit centroid — olive while pending, green
              with a checkmark once done. Pure rendering: handleTap never
              looks at these, so they can't steal taps from the units. */}
          {tourStops?.map((s, i) => {
            const u = TOUR_UNIT_CENTER.get(s.unitNumber);
            if (!u) return null;
            const label = s.isDone ? String.fromCodePoint(IONICONS_GLYPHS["checkmark"]) : `${i + 1}`;
            const font = s.isDone ? tourCheckFont : tourNumberFont;
            const size = s.isDone ? TOUR_CHECK_SIZE : TOUR_NUM_SIZE;
            const labelW = font ? font.getTextWidth(label) : 0;
            return (
              <Group key={`tour-${s.unitNumber}`}>
                <Circle cx={u.cx} cy={u.cy} r={TOUR_BADGE_R} color={s.isDone ? TOUR_DONE : OLIVE} />
                <Circle
                  cx={u.cx}
                  cy={u.cy}
                  r={TOUR_BADGE_R}
                  color="rgba(255,255,255,0.95)"
                  style="stroke"
                  strokeWidth={2.2}
                />
                {font ? (
                  <SkiaText
                    x={u.cx - labelW / 2}
                    y={u.cy + size * 0.36}
                    text={label}
                    font={font}
                    color="#FFFFFF"
                  />
                ) : null}
              </Group>
            );
          })}
        </Group>

        {/* Connector between card and unit — screen space, so the dashes stay
            1.5pt at every zoom (Swift drew this the same way). */}
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

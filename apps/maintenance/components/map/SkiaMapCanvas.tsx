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
import { MUTED } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";
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
import { placeTooltip, TIP_W, type TooltipPlacement } from "@/lib/map/tooltip-placement";
import type { LineStyle, LineWeight, UtilityPoint } from "@/lib/api/annotations";
import {
  LINE_WEIGHT_FACTOR,
  UTILITY_COLORS,
  effectiveLineStyle,
  effectiveLineWeight,
  flowChevrons,
  hitTestUtilityLines,
  polylineMidpoint,
  runLengthLabel,
} from "@/lib/utility-lines";
import { buildPlanPicture } from "@emberly/ui";

const DEFAULT_FILL = "rgba(9,27,84,0.10)";
const FADED_FILL = "rgba(9,27,84,0.035)";
/** Search-match wash over a unit. Alpha suffix on the accent — the tint has to
 *  follow the theme, and Skia takes #RRGGBBAA the same as RN does. */
const MATCH_ALPHA = "9E";
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

// Utility layer (sewer/water/gas/electrical runs + utility pins). Markers are
// the annotation pins at ~70% size; strokes hold a constant on-screen width
// (divided by the effective scale each frame) so a run reads the same at
// every zoom instead of ballooning at 8×.
const UTIL_PIN_R = PIN_R * 0.7;
const UTIL_PIN_RING = 3.4 * 0.7;
const UTIL_PIN_ICON_SIZE = 18;
const UTIL_STROKE = 2.5;
/** Dash intervals in screen pt — scaled by 1/eff alongside the stroke.
 *  These are per-run STYLES now (see effectiveLineStyle): historically sewer
 *  drew dashed and gas dotted, which the style fallback preserves. */
const UTIL_DASH_DASHED: [number, number] = [9, 6];
const UTIL_DASH_DOTTED: [number, number] = [2.5, 6];
/** Vertex discs on the in-progress draw, page space like the pins. */
const DRAFT_VERTEX_R = 7;
/** Run labels: page-space pill riding the run's midpoint (like tour badges). */
const RUN_LABEL_SIZE = 26;
const RUN_LABEL_PAD_X = 14;
const RUN_LABEL_PAD_Y = 9;
/** Lift the pill off the stroke so it doesn't sit on the dashes. */
const RUN_LABEL_LIFT = 30;

function utilityColor(a: { utilityType?: MapAnnotation["utilityType"] }): string {
  return UTILITY_COLORS[a.utilityType ?? "other"];
}

/** Page-space Skia path through a run's normalized vertices. */
function buildUtilityPath(points: UtilityPoint[]) {
  const b = Skia.PathBuilder.Make();
  points.forEach((p, i) => {
    if (i === 0) b.moveTo(p.x * PAGE_WIDTH, p.y * PAGE_HEIGHT);
    else b.lineTo(p.x * PAGE_WIDTH, p.y * PAGE_HEIGHT);
  });
  return b.detach();
}

/** Ionicons rendered straight onto the pins via the bundled typeface. */
const IONICONS_TTF = require("@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf");
const IONICONS_GLYPHS: Record<
  string,
  number
> = require("@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json");
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
/** Dashed route threading the tour stops — accent at 92%. */
const TOUR_ROUTE_ALPHA = "EB";
const TOUR_ROUTE_WIDTH = 4;

/** Page-space centroid per unit, for placing tour badges. */
const TOUR_UNIT_CENTER = new Map(PLACED_UNITS.map((u) => [u.number, u]));

/** A stop the canvas needs to badge — the store's TourStop satisfies this. */
export interface TourBadgeStop {
  unitNumber: string;
  isDone: boolean;
}

export type PlaceMode = "none" | "annotate" | "utility";

interface UnitsLayerProps {
  /** Accent + MATCH_ALPHA, resolved by the parent. */
  matchFill: string;
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

const UnitsLayer = memo(function UnitsLayer({
  matchFill,
  matched,
  hasQuery,
  colorMap,
  showPlan,
}: UnitsLayerProps) {
  // The flat ink veils follow the scheme: navy tints vanish over the dark
  // canvas ground, so dark mode lifts them to white washes instead.
  const layerDark = useColorScheme().colorScheme === "dark";
  const defaultFill = layerDark ? "rgba(255,255,255,0.10)" : DEFAULT_FILL;
  const fadedFill = layerDark ? "rgba(255,255,255,0.045)" : FADED_FILL;
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
      ? matchFill
      : hasQuery
        ? fadedFill
        : (c?.fill ?? (showPlan ? undefined : defaultFill));
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
  /** The utility run being drawn right now — rendered live above the saved runs. */
  utilityDraft?: {
    points: UtilityPoint[];
    color: string;
    /** Live style preview while drawing; absent falls back to solid/medium. */
    style?: LineStyle;
    weight?: LineWeight;
    arrows?: boolean;
  };
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
  /** A tap in utility mode: normalized page point for a vertex or utility pin. */
  onPlaceUtility: (nx: number, ny: number) => void;
  /** A tap landed on an existing utility pin or run. */
  onSelectUtility: (id: string) => void;
  /** The run open in the inspector — drawn with the mockup's halo + vertex dots. */
  selectedUtilityId?: string;
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
  utilityDraft,
  tourStops,
  night,
  placeMode,
  showPlan,
  tooltip,
  onSelect,
  onPlacePin,
  onSelectPin,
  onPlaceUtility,
  onSelectUtility,
  selectedUtilityId,
}: SkiaMapCanvasProps) {
  const palette = useAccentPalette();
  const dark = useColorScheme().colorScheme === "dark";
  const pinIconFont = useFont(IONICONS_TTF, PIN_ICON_SIZE);
  const utilPinIconFont = useFont(IONICONS_TTF, UTIL_PIN_ICON_SIZE);
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
  // Run labels use the same face at their own page-space size.
  const runLabelFont = useMemo(
    () =>
      matchFont({
        fontFamily: Platform.select({ ios: "Helvetica Neue", default: "sans-serif" }),
        fontSize: RUN_LABEL_SIZE,
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

  // Utility layer, split once per annotations change. Lines carry a prebuilt
  // page-space path plus their per-RUN presentation (style/weight/arrows from
  // the record, falling back to the historical per-type defaults); pins and
  // utility pins render (and hit-test) separately.
  const utilityLines = useMemo(() => {
    const out: {
      id: string;
      color: string;
      style: LineStyle;
      weight: LineWeight;
      path: ReturnType<typeof buildUtilityPath>;
      /** Prebuilt page-space chevron path; null when arrows are off. */
      arrows: ReturnType<typeof buildUtilityPath> | null;
      /** Label pill at the run's midpoint; null when untitled. */
      label: { text: string; x: number; y: number; w: number } | null;
      /** Vertices, for the selection treatment (mockup: white dots on the
       *  inspected run). */
      points: UtilityPoint[];
    }[] = [];
    for (const a of annotations) {
      if (a.kind !== "utility_line" || !a.points || a.points.length < 2) continue;

      let arrows: ReturnType<typeof buildUtilityPath> | null = null;
      if (a.flowArrows) {
        const b = Skia.PathBuilder.Make();
        for (const c of flowChevrons(a.points, PAGE_WIDTH, PAGE_HEIGHT)) {
          b.moveTo(c.leftX, c.leftY);
          b.lineTo(c.tipX, c.tipY);
          b.lineTo(c.rightX, c.rightY);
        }
        arrows = b.detach();
      }

      let label: { text: string; x: number; y: number; w: number } | null = null;
      const text = [a.title.trim(), runLengthLabel(a.points, PAGE_WIDTH, PAGE_HEIGHT)]
        .filter(Boolean)
        .join(" · ");
      if (text) {
        const mid = polylineMidpoint(a.points, PAGE_WIDTH, PAGE_HEIGHT);
        if (mid)
          label = { text, x: mid.x, y: mid.y - RUN_LABEL_LIFT, w: runLabelFont.getTextWidth(text) };
      }

      out.push({
        id: a.id,
        color: utilityColor(a),
        style: effectiveLineStyle(a),
        weight: effectiveLineWeight(a),
        path: buildUtilityPath(a.points),
        arrows,
        label,
        points: a.points,
      });
    }
    return out;
  }, [annotations, runLabelFont]);
  const utilityPins = useMemo(
    () => annotations.filter((a) => a.kind === "utility_pin"),
    [annotations],
  );
  const pins = useMemo(
    () => annotations.filter((a) => a.kind !== "utility_pin" && a.kind !== "utility_line"),
    [annotations],
  );
  const draftPath = useMemo(
    () =>
      utilityDraft && utilityDraft.points.length >= 2
        ? buildUtilityPath(utilityDraft.points)
        : null,
    [utilityDraft],
  );
  const draftArrows = useMemo(() => {
    if (!utilityDraft?.arrows || utilityDraft.points.length < 2) return null;
    const b = Skia.PathBuilder.Make();
    for (const c of flowChevrons(utilityDraft.points, PAGE_WIDTH, PAGE_HEIGHT)) {
      b.moveTo(c.leftX, c.leftY);
      b.lineTo(c.tipX, c.tipY);
      b.lineTo(c.rightX, c.rightY);
    }
    return b.detach();
  }, [utilityDraft]);

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
        y: Math.min(
          Math.max(y, Math.min(0, height - h) - slackY),
          Math.max(0, height - h) + slackY,
        ),
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

    if (placeMode === "annotate") return onPlacePin(wx / PAGE_WIDTH, wy / PAGE_HEIGHT);
    if (placeMode === "utility") return onPlaceUtility(wx / PAGE_WIDTH, wy / PAGE_HEIGHT);

    // Markers first (a line's anchor point is not tappable — only its stroke),
    // then the drawn runs, then the units underneath everything.
    for (const a of annotations) {
      if (a.kind === "utility_line") continue;
      const dx = wx - a.x * PAGE_WIDTH;
      const dy = wy - a.y * PAGE_HEIGHT;
      if (dx * dx + dy * dy <= HIT_R2) {
        return a.kind === "utility_pin" ? onSelectUtility(a.id) : onSelectPin(a.id);
      }
    }
    const lineId = hitTestUtilityLines(annotations, wx, wy, PAGE_WIDTH, PAGE_HEIGHT);
    if (lineId) return onSelectUtility(lineId);
    const hit = PLACED_UNITS.find(
      (u) => wx >= u.x && wx <= u.x + u.w && wy >= u.y && wy <= u.y + u.h,
    );
    // Tap-away clears the selection, like the Swift map — "" means none.
    onSelect(hit ? hit.number : "");
  };
  const tapRef = useRef(handleTap);
  tapRef.current = handleTap;
  const onTapJS = useCallback((px: number, py: number) => tapRef.current(px, py), []);

  /** Long-press: utility markings only — pins first, then runs. */
  const handleLongPress = (px: number, py: number) => {
    if (placeMode !== "none") return;
    const eff = scale.value * baseScale;
    const wx = (px - tx.value) / eff;
    const wy = (py - ty.value) / eff;
    for (const a of annotations) {
      if (a.kind !== "utility_pin") continue;
      const dx = wx - a.x * PAGE_WIDTH;
      const dy = wy - a.y * PAGE_HEIGHT;
      if (dx * dx + dy * dy <= HIT_R2) return onSelectUtility(a.id);
    }
    const lineId = hitTestUtilityLines(annotations, wx, wy, PAGE_WIDTH, PAGE_HEIGHT);
    if (lineId) onSelectUtility(lineId);
  };
  const longPressRef = useRef(handleLongPress);
  longPressRef.current = handleLongPress;
  const onLongPressJS = useCallback((px: number, py: number) => longPressRef.current(px, py), []);

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

    // Long-press opens a utility marking's inspector directly (pins + runs) —
    // the deliberate hold reads as "edit this", and a still finger can't be
    // navigation, so it never fights the pan.
    const longPress = Gesture.LongPress()
      .minDuration(420)
      .maxDistance(12)
      .onStart((e) => {
        "worklet";
        runOnJS(onLongPressJS)(e.x, e.y);
      });

    // Exclusive: the tap only claims the touch when the nav gestures FAIL —
    // running it Simultaneous with pan/pinch made every short navigation flick
    // also select whatever was under the finger (the false-click complaint).
    return Gesture.Exclusive(Gesture.Simultaneous(pan, pinch), longPress, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTapJS, onLongPressJS, baseScale]);

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

  // Utility runs get the same treatment: ~2.5pt strokes (and matching dash
  // intervals) whatever the zoom, so a gas dotted run doesn't turn into
  // page-sized blobs at 8×.
  const utilityStroke = useDerivedValue(() => UTIL_STROKE / (scale.value * baseScale), [baseScale]);
  // One derived stroke per weight tier — hooks can't run per line, so each
  // run picks its tier from this trio at render.
  const utilityStrokeThin = useDerivedValue(
    () => (UTIL_STROKE * LINE_WEIGHT_FACTOR.thin) / (scale.value * baseScale),
    [baseScale],
  );
  const utilityStrokeThick = useDerivedValue(
    () => (UTIL_STROKE * LINE_WEIGHT_FACTOR.thick) / (scale.value * baseScale),
    [baseScale],
  );
  const utilityDashDashed = useDerivedValue(() => {
    const eff = scale.value * baseScale;
    return [UTIL_DASH_DASHED[0] / eff, UTIL_DASH_DASHED[1] / eff];
  }, [baseScale]);
  const utilityDashDotted = useDerivedValue(() => {
    const eff = scale.value * baseScale;
    return [UTIL_DASH_DOTTED[0] / eff, UTIL_DASH_DOTTED[1] / eff];
  }, [baseScale]);
  // Chevron arms hold ~2pt on screen like the strokes they ride.
  const utilityArrowStroke = useDerivedValue(() => 2 / (scale.value * baseScale), [baseScale]);
  // The selection halo: a wide soft band under the inspected run.
  const utilityHaloStroke = useDerivedValue(
    () => (UTIL_STROKE * 3.2) / (scale.value * baseScale),
    [baseScale],
  );
  const strokeForWeight = (weight: LineWeight) =>
    weight === "thin" ? utilityStrokeThin : weight === "thick" ? utilityStrokeThick : utilityStroke;

  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={gesture}>
        <Canvas style={{ width, height }}>
          {/* The canvas floor — what shows beyond the page edges. */}
          <Fill color={dark ? "#101318" : "#F6F4EB"} />
          <Group transform={transform}>
            {showPlan ? <Picture picture={plan} /> : null}
            <UnitsLayer
              matchFill={`${palette.fill}${MATCH_ALPHA}`}
              matched={matched}
              hasQuery={hasQuery}
              colorMap={colorMap}
              showPlan={showPlan}
            />

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
            {/* Utility runs: beneath the pins, above the plan/units. Style,
              weight, and flow arrows come from the record (effectiveLineStyle
              keeps pre-style rows on the old sewer-dashed/gas-dotted look). */}
            {utilityLines.map((l) => (
              <Group key={l.id}>
                {/* Selection treatment (mockup): a soft same-hue halo under the
                  inspected run, white vertex dots on top of it below. */}
                {l.id === selectedUtilityId ? (
                  <Path
                    path={l.path}
                    style="stroke"
                    strokeWidth={utilityHaloStroke}
                    strokeCap="round"
                    strokeJoin="round"
                    color={l.color}
                    opacity={0.16}
                  />
                ) : null}
                <Path
                  path={l.path}
                  style="stroke"
                  strokeWidth={strokeForWeight(l.weight)}
                  strokeCap="round"
                  strokeJoin="round"
                  color={l.color}
                >
                  {l.style === "dashed" ? (
                    <DashPathEffect intervals={utilityDashDashed} />
                  ) : l.style === "dotted" ? (
                    <DashPathEffect intervals={utilityDashDotted} />
                  ) : null}
                </Path>
                {l.arrows ? (
                  <Path
                    path={l.arrows}
                    style="stroke"
                    strokeWidth={utilityArrowStroke}
                    strokeCap="round"
                    strokeJoin="round"
                    color={l.color}
                  />
                ) : null}
                {l.id === selectedUtilityId
                  ? l.points.map((p, i) => (
                      <Group key={i}>
                        <Circle
                          cx={p.x * PAGE_WIDTH}
                          cy={p.y * PAGE_HEIGHT}
                          r={DRAFT_VERTEX_R}
                          color="#FFFFFF"
                        />
                        <Circle
                          cx={p.x * PAGE_WIDTH}
                          cy={p.y * PAGE_HEIGHT}
                          r={DRAFT_VERTEX_R}
                          color={l.color}
                          style="stroke"
                          strokeWidth={2.6}
                        />
                      </Group>
                    ))
                  : null}
                {l.label ? (
                  <Group>
                    <RoundedRect
                      x={l.label.x - l.label.w / 2 - RUN_LABEL_PAD_X}
                      y={l.label.y - RUN_LABEL_SIZE / 2 - RUN_LABEL_PAD_Y}
                      width={l.label.w + RUN_LABEL_PAD_X * 2}
                      height={RUN_LABEL_SIZE + RUN_LABEL_PAD_Y * 2}
                      r={(RUN_LABEL_SIZE + RUN_LABEL_PAD_Y * 2) / 2}
                      color={l.color}
                      opacity={0.92}
                    />
                    <SkiaText
                      x={l.label.x - l.label.w / 2}
                      y={l.label.y + RUN_LABEL_SIZE * 0.36}
                      text={l.label.text}
                      font={runLabelFont}
                      color="#FFFFFF"
                    />
                  </Group>
                ) : null}
              </Group>
            ))}

            {/* The in-progress draw: live polyline plus a disc per vertex, so
              the first tap is visible before there's a segment to stroke. */}
            {utilityDraft ? (
              <Group>
                {draftPath ? (
                  <Path
                    path={draftPath}
                    style="stroke"
                    strokeWidth={strokeForWeight(utilityDraft.weight ?? "medium")}
                    strokeCap="round"
                    strokeJoin="round"
                    color={utilityDraft.color}
                    opacity={0.9}
                  >
                    {utilityDraft.style === "dashed" ? (
                      <DashPathEffect intervals={utilityDashDashed} />
                    ) : utilityDraft.style === "dotted" ? (
                      <DashPathEffect intervals={utilityDashDotted} />
                    ) : null}
                  </Path>
                ) : null}
                {draftArrows ? (
                  <Path
                    path={draftArrows}
                    style="stroke"
                    strokeWidth={utilityArrowStroke}
                    strokeCap="round"
                    strokeJoin="round"
                    color={utilityDraft.color}
                    opacity={0.9}
                  />
                ) : null}
                {utilityDraft.points.map((p, i) => (
                  <Group key={i}>
                    <Circle
                      cx={p.x * PAGE_WIDTH}
                      cy={p.y * PAGE_HEIGHT}
                      r={DRAFT_VERTEX_R}
                      color={utilityDraft.color}
                    />
                    <Circle
                      cx={p.x * PAGE_WIDTH}
                      cy={p.y * PAGE_HEIGHT}
                      r={DRAFT_VERTEX_R}
                      color="rgba(255,255,255,0.85)"
                      style="stroke"
                      strokeWidth={2}
                    />
                  </Group>
                ))}
              </Group>
            ) : null}

            {/* Utility pins: the annotation pin treatment at ~70% — the pin's
              own color (falling back to its type's) with its icon glyph, so
              a customized pin reads at a glance. */}
            {utilityPins.map((a) => {
              const cx = a.x * PAGE_WIDTH;
              const cy = a.y * PAGE_HEIGHT;
              const fill = a.color || utilityColor(a);
              const glyph = pinGlyph(a.icon || "construct");
              const glyphW = utilPinIconFont ? utilPinIconFont.getTextWidth(glyph) : 0;
              return (
                <Group key={a.id}>
                  <Circle cx={cx} cy={cy} r={UTIL_PIN_R} color={fill} />
                  <Circle
                    cx={cx}
                    cy={cy}
                    r={UTIL_PIN_R}
                    color="rgba(255,255,255,0.85)"
                    style="stroke"
                    strokeWidth={UTIL_PIN_RING}
                  />
                  {utilPinIconFont ? (
                    <SkiaText
                      x={cx - glyphW / 2}
                      y={cy + UTIL_PIN_ICON_SIZE * 0.36}
                      text={glyph}
                      font={utilPinIconFont}
                      color="#FFFFFF"
                    />
                  ) : null}
                </Group>
              );
            })}

            {/* Pins: colored disc, white ring, and the pin's chosen Ionicons
              glyph (note, unlocked door, trash, …) drawn with the real font. */}
            {pins.map((a) => {
              const cx = a.x * PAGE_WIDTH;
              const cy = a.y * PAGE_HEIGHT;
              const glyph = pinGlyph(a.icon);
              const glyphW = pinIconFont ? pinIconFont.getTextWidth(glyph) : 0;
              return (
                <Group key={a.id}>
                  <Circle cx={cx} cy={cy} r={PIN_R} color={a.color} />
                  <Circle
                    cx={cx}
                    cy={cy}
                    r={PIN_R}
                    color="rgba(255,255,255,0.85)"
                    style="stroke"
                    strokeWidth={3.4}
                  />
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
                color={`${palette.text}${TOUR_ROUTE_ALPHA}`}
              >
                <DashPathEffect intervals={[TOUR_BADGE_R, TOUR_BADGE_R * 0.7]} />
              </Path>
            ) : null}

            {/* Tour route badges (TourRouteMapOverlayLayout.swift): a numbered
              disc at each stop's unit centroid — accent while pending, green
              with a checkmark once done. Pure rendering: handleTap never
              looks at these, so they can't steal taps from the units. */}
            {tourStops?.map((s, i) => {
              const u = TOUR_UNIT_CENTER.get(s.unitNumber);
              if (!u) return null;
              const label = s.isDone
                ? String.fromCodePoint(IONICONS_GLYPHS["checkmark"])
                : `${i + 1}`;
              const font = s.isDone ? tourCheckFont : tourNumberFont;
              const size = s.isDone ? TOUR_CHECK_SIZE : TOUR_NUM_SIZE;
              const labelW = font ? font.getTextWidth(label) : 0;
              return (
                <Group key={`tour-${s.unitNumber}`}>
                  <Circle
                    cx={u.cx}
                    cy={u.cy}
                    r={TOUR_BADGE_R}
                    color={s.isDone ? TOUR_DONE : palette.fill}
                  />
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
        <Animated.View style={[{ position: "absolute", width: TIP_W }, tooltipStyle]}>
          {tooltip}
        </Animated.View>
      ) : null}
    </View>
  );
}

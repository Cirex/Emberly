import type { LineStyle, LineWeight, UtilityPoint, UtilityType } from "@/lib/api/annotations";

/**
 * Utility-layer presentation constants and line geometry, kept pure so the
 * tap hit-test is unit-testable. The Skia canvas draws with these; the map
 * screen colors its type chips with them.
 */

/** Per-type stroke/marker color (matches the admin portal's utility layer). */
export const UTILITY_COLORS: Record<UtilityType, string> = {
  water: "#2563B4",
  sewer: "#6B4A2B",
  gas: "#BA7517",
  electrical: "#7F77DD",
  other: "#888780",
};

/** Tap slop around a drawn run, in page (world) pixels — a shade under the
 *  pins' ~63px radius so a pin sitting on a line still wins its own tap. */
export const UTILITY_LINE_HIT_PX = 45;

/* ---------------- per-run presentation ---------------- */

/** The slice of a run the presentation resolvers need. */
export interface UtilityRunLike {
  utilityType?: UtilityType;
  lineStyle?: LineStyle;
  lineWeight?: LineWeight;
  flowArrows?: boolean;
}

/**
 * A run with no stored style keeps the pre-style rendering — sewer dashed,
 * gas dotted, everything else solid — so rows drawn before the style fields
 * (and rows written by older builds) look exactly as they always have.
 */
export function effectiveLineStyle(run: UtilityRunLike): LineStyle {
  if (run.lineStyle) return run.lineStyle;
  if (run.utilityType === "sewer") return "dashed";
  if (run.utilityType === "gas") return "dotted";
  return "solid";
}

/** Stroke-width multiplier per weight; medium is the historical 1×. */
export const LINE_WEIGHT_FACTOR: Record<LineWeight, number> = {
  thin: 0.6,
  medium: 1,
  thick: 1.7,
};

export function effectiveLineWeight(run: UtilityRunLike): LineWeight {
  return run.lineWeight ?? "medium";
}

/** Polyline length in page (world) pixels. */
export function polylineLengthPx(
  points: readonly UtilityPoint[],
  pageWidth: number,
  pageHeight: number,
): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = (points[i + 1].x - points[i].x) * pageWidth;
    const dy = (points[i + 1].y - points[i].y) * pageHeight;
    total += Math.hypot(dx, dy);
  }
  return total;
}

/**
 * Real-world feet per page pixel, or null while uncalibrated. The site plan
 * has no known scale yet — measure one known dimension (a building length,
 * a parking row) on the plan and set feet/pagePx here; every length readout
 * lights up at once. Null hides lengths rather than inventing them.
 */
export const FEET_PER_PAGE_PX: number | null = null;

/** "212 ft" when calibrated, null otherwise (callers hide the readout). */
export function runLengthLabel(
  points: readonly UtilityPoint[],
  pageWidth: number,
  pageHeight: number,
): string | null {
  if (FEET_PER_PAGE_PX === null) return null;
  const feet = polylineLengthPx(points, pageWidth, pageHeight) * FEET_PER_PAGE_PX;
  return `${Math.round(feet)} ft`;
}

/** One flow chevron: three page-space points, open toward the tip. */
export interface FlowChevron {
  tipX: number;
  tipY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

/** Spacing between chevrons and arm half-length, in page pixels. Sized like
 *  the pins (PIN_R 22): fixed on the page, so they scale with zoom. */
export const CHEVRON_SPACING_PX = 220;
export const CHEVRON_HALF_PX = 13;

/**
 * Repeating direction chevrons along the run (first vertex → last), one per
 * CHEVRON_SPACING_PX of arc length starting half a spacing in — so a short
 * two-point run still gets one chevron at its middle.
 */
export function flowChevrons(
  points: readonly UtilityPoint[],
  pageWidth: number,
  pageHeight: number,
  spacing: number = CHEVRON_SPACING_PX,
  half: number = CHEVRON_HALF_PX,
): FlowChevron[] {
  if (points.length < 2) return [];
  const px = points.map((p) => ({ x: p.x * pageWidth, y: p.y * pageHeight }));

  // Cumulative arc length per vertex.
  const cum: number[] = [0];
  for (let i = 1; i < px.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [];

  const out: FlowChevron[] = [];
  const wing = half * 0.75;
  for (let dist = Math.min(spacing * 0.5, total / 2); dist < total; dist += spacing) {
    // Segment containing this arc-length position.
    let seg = 1;
    while (seg < cum.length - 1 && cum[seg] < dist) seg++;
    const segLen = cum[seg] - cum[seg - 1];
    if (segLen === 0) continue;
    const t = (dist - cum[seg - 1]) / segLen;
    const cx = px[seg - 1].x + (px[seg].x - px[seg - 1].x) * t;
    const cy = px[seg - 1].y + (px[seg].y - px[seg - 1].y) * t;
    const ux = (px[seg].x - px[seg - 1].x) / segLen;
    const uy = (px[seg].y - px[seg - 1].y) / segLen;
    out.push({
      tipX: cx + ux * half,
      tipY: cy + uy * half,
      leftX: cx - ux * half * 0.4 - uy * wing,
      leftY: cy - uy * half * 0.4 + ux * wing,
      rightX: cx - ux * half * 0.4 + uy * wing,
      rightY: cy - uy * half * 0.4 - ux * wing,
    });
  }
  return out;
}

/** The arc-length midpoint of the run, in page pixels — label anchor. */
export function polylineMidpoint(
  points: readonly UtilityPoint[],
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number } | null {
  if (points.length < 2) return null;
  const px = points.map((p) => ({ x: p.x * pageWidth, y: p.y * pageHeight }));
  const cum: number[] = [0];
  for (let i = 1; i < px.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y));
  }
  const half = cum[cum.length - 1] / 2;
  if (cum[cum.length - 1] === 0) return px[0];
  let seg = 1;
  while (seg < cum.length - 1 && cum[seg] < half) seg++;
  const segLen = cum[seg] - cum[seg - 1];
  const t = segLen === 0 ? 0 : (half - cum[seg - 1]) / segLen;
  return {
    x: px[seg - 1].x + (px[seg].x - px[seg - 1].x) * t,
    y: px[seg - 1].y + (px[seg].y - px[seg - 1].y) * t,
  };
}

/** Squared distance from (px,py) to the segment (ax,ay)–(bx,by). */
export function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // Degenerate segment (repeated vertex) measures to the point itself.
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** The slice of an annotation the hit-test needs. */
export interface UtilityLineLike {
  id: string;
  kind?: string;
  points?: UtilityPoint[] | null;
}

/**
 * Hit-test a world-space tap against the drawn utility runs. Points are
 * normalized 0–1, so they scale by the page size into the same space as the
 * tap. Returns the id of the NEAREST line within the threshold — with runs
 * often sharing a trench, "closest wins" beats "first in list wins".
 */
export function hitTestUtilityLines(
  annotations: readonly UtilityLineLike[],
  wx: number,
  wy: number,
  pageWidth: number,
  pageHeight: number,
  thresholdPx: number = UTILITY_LINE_HIT_PX,
): string | undefined {
  let bestId: string | undefined;
  let bestD = thresholdPx * thresholdPx;
  for (const a of annotations) {
    if (a.kind !== "utility_line" || !a.points || a.points.length < 2) continue;
    for (let i = 0; i < a.points.length - 1; i++) {
      const d = distToSegmentSq(
        wx,
        wy,
        a.points[i].x * pageWidth,
        a.points[i].y * pageHeight,
        a.points[i + 1].x * pageWidth,
        a.points[i + 1].y * pageHeight,
      );
      if (d <= bestD) {
        bestD = d;
        bestId = a.id;
      }
    }
  }
  return bestId;
}

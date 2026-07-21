import type { UtilityPoint, UtilityType } from "@/lib/api/annotations";

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

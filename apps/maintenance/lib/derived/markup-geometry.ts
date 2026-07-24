import type { MarkupPoint, MarkupStroke } from "@/lib/derived/photo-markup";

/**
 * Pure geometry for rendering markup strokes — the parts worth testing away
 * from a Canvas. A stroke stores only its defining points (freehand: the path;
 * circle/arrow: two corners; note: one anchor); everything drawn from that —
 * the ellipse box, the arrow's barbs — is derived here so the renderer and the
 * flatten-to-file pass agree exactly.
 */

/** Axis-aligned box from a stroke's two corner points, normalized so w/h ≥ 0. */
export function rectFromCorners(a: MarkupPoint, b: MarkupPoint): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/**
 * The two barb points of an arrowhead at `end`, pointing back toward `start`.
 * `size` is the barb length in the same units as the points; the barbs sit at
 * ±`spreadRad` off the shaft. A zero-length shaft has no direction, so the
 * barbs collapse onto the tip rather than shooting off to NaN.
 */
export function arrowHead(
  start: MarkupPoint,
  end: MarkupPoint,
  size = 18,
  spreadRad = Math.PI / 7,
): [MarkupPoint, MarkupPoint] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [{ ...end }, { ...end }];

  const angle = Math.atan2(dy, dx);
  const barb = (sign: number): MarkupPoint => ({
    x: end.x - size * Math.cos(angle + sign * spreadRad),
    y: end.y - size * Math.sin(angle + sign * spreadRad),
  });
  return [barb(1), barb(-1)];
}

/** First and last point of a stroke's path (freehand start/end, or the two
 *  corners of a circle/arrow). Null when the stroke has no points. */
export function endpoints(stroke: MarkupStroke): {
  start: MarkupPoint;
  end: MarkupPoint;
} | null {
  if (stroke.points.length === 0) return null;
  return {
    start: stroke.points[0],
    end: stroke.points[stroke.points.length - 1],
  };
}

/** Whether a drag is deliberate enough to keep, versus an accidental tap.
 *  Freehand keeps anything with 2+ points; shapes need a minimum diagonal. */
export function isMeaningfulStroke(stroke: MarkupStroke, minSpan = 6): boolean {
  if (stroke.tool === "note") return stroke.points.length >= 1;
  if (stroke.tool === "freehand") return stroke.points.length >= 2;
  const ends = endpoints(stroke);
  if (!ends) return false;
  return Math.hypot(ends.end.x - ends.start.x, ends.end.y - ends.start.y) >= minSpan;
}

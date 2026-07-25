/**
 * Where the unit callout sits relative to the unit it describes.
 *
 * Extracted from SkiaMapCanvas so it can be tested as the pure geometry it is —
 * it runs as a worklet on the UI thread, so it stays self-contained (no imports,
 * no closed-over helpers).
 *
 * Twelve candidate positions — 4 axial, 4 corner-offset, 4 true-45° rays — the
 * nearest one that fully fits wins, else the least-overflowing one, and the
 * result is always clamped inside the viewport so the card can never leave the
 * screen however small it is. The connector exits the card edge facing the unit,
 * with an L-elbow unless the two are nearly axis-aligned.
 *
 * "Nearest" REPLACED "most available space", which was the port of Swift's
 * tooltipPlacement(). Ranking by space meant a corner candidate scored
 * `spaceRight + spaceBelow` against an axial candidate's `spaceRight` alone, so
 * any unit with room on every side — i.e. anything near the middle of the
 * screen — always lost to a diagonal placement and opened its card ~120pt down
 * and ~140pt across, trailing a long elbow connector. Near an edge one of the
 * sums collapsed and an axial candidate won, which is why the callout only
 * looked detached in the middle. Space still decides what FITS (via overflow);
 * it no longer decides what is chosen among those that do.
 */

/** Tooltip card footprint used for placement (content sizes itself within).
    Width matches the Swift card (286 content + padding). */
export const TIP_W = 250;
export const TIP_H = 205;
/** Clearance between the unit's edge and the card. */
export const TIP_GAP = 16;
/** Minimum clearance between the card and the viewport edge. */
export const TIP_PAD = 8;

export interface TooltipPlacement {
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

export function placeTooltip(
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
  const gap = TIP_GAP;
  const pad = TIP_PAD;
  const minX = pad;
  const minY = pad;
  const maxX = vw - pad;
  const maxY = vh - pad;
  const cx = ux + uw / 2;
  const cy = uy + uh / 2;

  const d45 = (Math.max(uw, uh) * 0.5 + gap) / Math.SQRT2;

  // Declaration order is the tie-break: axial before corner before 45° ray, and
  // right before left before below before above. A square unit dead-centre
  // therefore opens its card to the right, consistently.
  const candidates: { x: number; y: number }[] = [
    { x: ux + uw + gap + halfW, y: cy },
    { x: ux - gap - halfW, y: cy },
    { x: cx, y: uy + uh + gap + halfH },
    { x: cx, y: uy - gap - halfH },
    { x: ux + uw + gap + halfW, y: uy + uh + gap + halfH },
    { x: ux - gap - halfW, y: uy + uh + gap + halfH },
    { x: ux + uw + gap + halfW, y: uy - gap - halfH },
    { x: ux - gap - halfW, y: uy - gap - halfH },
    { x: cx + d45 + halfW, y: cy + d45 + halfH },
    { x: cx - d45 - halfW, y: cy + d45 + halfH },
    { x: cx + d45 + halfW, y: cy - d45 - halfH },
    { x: cx - d45 - halfW, y: cy - d45 - halfH },
  ];

  let best = candidates[0];
  let bestOverflow = Infinity;
  let bestDistance = Infinity;

  for (const c of candidates) {
    // How far the card would spill past the viewport, summed over both axes.
    const ox = Math.max(0, minX - (c.x - halfW)) + Math.max(0, c.x + halfW - maxX);
    const oy = Math.max(0, minY - (c.y - halfH)) + Math.max(0, c.y + halfH - maxY);
    const o = ox + oy;

    // How far the card would open from the unit: the gap between the unit's
    // centre and the nearest point of the card — the length of the connector,
    // which is exactly what reads as "far away".
    const gx = Math.max(0, Math.abs(cx - c.x) - halfW);
    const gy = Math.max(0, Math.abs(cy - c.y) - halfH);
    const d = Math.sqrt(gx * gx + gy * gy);

    // A candidate that fits always beats one that does not; among equals, the
    // closer one wins. Strict comparisons keep declaration order on ties.
    if (o < bestOverflow || (o === bestOverflow && d < bestDistance)) {
      best = c;
      bestOverflow = o;
      bestDistance = d;
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

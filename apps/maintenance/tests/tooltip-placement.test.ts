import { describe, expect, test } from "bun:test";
import {
  placeTooltip,
  TIP_GAP,
  TIP_H,
  TIP_PAD,
  TIP_W,
} from "@/lib/map/tooltip-placement";

/**
 * Tooltip placement geometry. The regression these guard is the one you see on
 * device: a unit in the middle of the screen opened its card diagonally, far
 * enough away that the connector needed an elbow to reach back.
 */

// A phone viewport, and a unit block roughly the size the map draws at 1x.
const VW = 390;
const VH = 780;
const UW = 44;
const UH = 30;

/** Gap between the unit's centre and the nearest edge of the card — the thing
    that reads as "how far away the tooltip opened". */
function connectorLength(
  p: { left: number; top: number },
  ux: number,
  uy: number,
  uw = UW,
  uh = UH,
) {
  const cx = ux + uw / 2;
  const cy = uy + uh / 2;
  const gx = Math.max(0, Math.abs(cx - (p.left + TIP_W / 2)) - TIP_W / 2);
  const gy = Math.max(0, Math.abs(cy - (p.top + TIP_H / 2)) - TIP_H / 2);
  return Math.sqrt(gx * gx + gy * gy);
}

function fitsOnScreen(p: { left: number; top: number }) {
  return (
    p.left >= TIP_PAD &&
    p.top >= TIP_PAD &&
    p.left + TIP_W <= VW - TIP_PAD &&
    p.top + TIP_H <= VH - TIP_PAD
  );
}

describe("placeTooltip", () => {
  test("a unit in the middle opens its card alongside, not diagonally", () => {
    const ux = VW / 2 - UW / 2;
    const uy = VH / 2 - UH / 2;
    const p = placeTooltip(ux, uy, UW, UH, VW, VH);

    // Alongside means axially aligned: the card's centre line matches the
    // unit's on one axis. The old space-ranked version offset BOTH axes.
    const sameRow = Math.abs(p.top + TIP_H / 2 - (uy + UH / 2)) < 0.001;
    const sameColumn = Math.abs(p.left + TIP_W / 2 - (ux + UW / 2)) < 0.001;
    expect(sameRow || sameColumn).toBe(true);

    // The connector is then a straight run, no elbow.
    expect(p.hasElbow).toBe(false);
  });

  test("the card opens no further than the clearance the layout asks for", () => {
    const ux = VW / 2 - UW / 2;
    const uy = VH / 2 - UH / 2;
    const p = placeTooltip(ux, uy, UW, UH, VW, VH);

    // Nearest possible is half the unit's shorter dimension plus the gap.
    const nearest = Math.min(UW, UH) / 2 + TIP_GAP;
    expect(connectorLength(p, ux, uy)).toBeCloseTo(nearest, 5);

    // The diagonal the old ranking chose was ~47pt out; anything in that range
    // is the bug returning.
    expect(connectorLength(p, ux, uy)).toBeLessThan(40);
  });

  test("no centred unit is ever placed diagonally", () => {
    // Sweep the middle of the screen — the region where every candidate fits
    // and the old ranking therefore always picked a corner.
    for (let x = 120; x <= VW - 120 - UW; x += 11) {
      for (let y = 240; y <= VH - 240 - UH; y += 13) {
        const p = placeTooltip(x, y, UW, UH, VW, VH);
        const sameRow = Math.abs(p.top + TIP_H / 2 - (y + UH / 2)) < 0.001;
        const sameColumn = Math.abs(p.left + TIP_W / 2 - (x + UW / 2)) < 0.001;
        expect({ x, y, axial: sameRow || sameColumn }).toEqual({ x, y, axial: true });
      }
    }
  });

  test("a unit against an edge gives up its nearest side rather than the screen", () => {
    // Hard against the right edge: the card cannot open right, so it opens
    // somewhere else that fits instead of hanging off the viewport.
    const ux = VW - UW - 2;
    const uy = VH / 2;
    const p = placeTooltip(ux, uy, UW, UH, VW, VH);

    expect(fitsOnScreen(p)).toBe(true);
    expect(p.left + TIP_W).toBeLessThanOrEqual(VW - TIP_PAD);
  });

  test("every position on screen keeps the whole card on screen", () => {
    for (let x = -20; x <= VW; x += 17) {
      for (let y = -20; y <= VH; y += 19) {
        const p = placeTooltip(x, y, UW, UH, VW, VH);
        expect({ x, y, fits: fitsOnScreen(p) }).toEqual({ x, y, fits: true });
      }
    }
  });

  test("a viewport too small for the card still clamps rather than drifting", () => {
    // The card is 250x205; this viewport cannot hold it on either axis.
    const p = placeTooltip(40, 40, UW, UH, 200, 160);
    expect(p.left).toBe(TIP_PAD);
    expect(p.top).toBe(TIP_PAD);
  });

  test("the connector starts on the card edge facing the unit", () => {
    const ux = VW / 2 - UW / 2;
    const uy = VH / 2 - UH / 2;
    const p = placeTooltip(ux, uy, UW, UH, VW, VH);

    // The exit point sits on the card's boundary, and the terminal end is the
    // unit's centre.
    const onVerticalEdge = Math.abs(Math.abs(p.sx - (p.left + TIP_W / 2)) - TIP_W / 2) < 0.001;
    const onHorizontalEdge = Math.abs(Math.abs(p.sy - (p.top + TIP_H / 2)) - TIP_H / 2) < 0.001;
    expect(onVerticalEdge || onHorizontalEdge).toBe(true);
    expect(p.ex).toBeCloseTo(ux + UW / 2, 5);
    expect(p.ey).toBeCloseTo(uy + UH / 2, 5);
  });

  test("the card opens on the side the unit is thinnest, given room for either", () => {
    // A tablet, where a 250pt-wide card genuinely fits left or right of centre.
    // On a 390pt phone it never does, so the choice there is always vertical.
    const TW = 1024;
    const TH = 768;
    const cx = TW / 2;
    const cy = TH / 2;

    // Tall and thin: the shorter way to the card is sideways.
    const tall = placeTooltip(cx - 10, cy - 60, 20, 120, TW, TH);
    expect(Math.abs(tall.top + TIP_H / 2 - cy)).toBeLessThan(0.001);

    // Wide and flat: the shorter way is up or down.
    const wide = placeTooltip(cx - 60, cy - 10, 120, 20, TW, TH);
    expect(Math.abs(wide.left + TIP_W / 2 - cx)).toBeLessThan(0.001);
  });

  test("on a phone the card cannot fit beside a centred unit, so it goes below", () => {
    // Documents WHY the phone case always resolves vertically: the card is
    // 250pt of a 390pt viewport, so a horizontal placement only fits for units
    // near the left or right edge. This is the layout, not the ranking.
    const ux = VW / 2 - UW / 2;
    const uy = VH / 2 - UH / 2;
    const p = placeTooltip(ux, uy, UW, UH, VW, VH);

    expect(Math.abs(p.left + TIP_W / 2 - (ux + UW / 2))).toBeLessThan(0.001);
    expect(p.top).toBeGreaterThan(uy);
  });
});

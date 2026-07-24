import { describe, expect, test } from "bun:test";

import {
  arrowHead,
  endpoints,
  isMeaningfulStroke,
  rectFromCorners,
} from "@/lib/derived/markup-geometry";
import type { MarkupStroke } from "@/lib/derived/photo-markup";

const stroke = (over: Partial<MarkupStroke> = {}): MarkupStroke => ({
  id: "s1",
  tool: "circle",
  color: "#FFD23F",
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ],
  ...over,
});

describe("rectFromCorners", () => {
  test("normalizes so width/height are never negative", () => {
    expect(rectFromCorners({ x: 10, y: 10 }, { x: 2, y: 4 })).toEqual({
      x: 2,
      y: 4,
      width: 8,
      height: 6,
    });
  });
});

describe("arrowHead", () => {
  test("barbs sit behind the tip, symmetric about the shaft", () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 18);
    // Pointing +x, both barbs are left of the tip and mirror across y=0.
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeLessThan(100);
    expect(a.y).toBeCloseTo(-b.y, 5);
  });

  test("a zero-length shaft collapses the barbs onto the tip, never NaN", () => {
    const [a, b] = arrowHead({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(a).toEqual({ x: 5, y: 5 });
    expect(b).toEqual({ x: 5, y: 5 });
  });
});

describe("endpoints", () => {
  test("returns first and last point", () => {
    const s = stroke({ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 9, y: 9 }] });
    expect(endpoints(s)).toEqual({ start: { x: 1, y: 1 }, end: { x: 9, y: 9 } });
  });

  test("null for an empty stroke", () => {
    expect(endpoints(stroke({ points: [] }))).toBeNull();
  });
});

describe("isMeaningfulStroke", () => {
  test("a shape needs a minimum diagonal — a tap is discarded", () => {
    expect(isMeaningfulStroke(stroke({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }))).toBe(false);
    expect(isMeaningfulStroke(stroke())).toBe(true); // 0,0 → 10,10 spans ~14
  });

  test("freehand keeps anything with two points", () => {
    expect(
      isMeaningfulStroke(stroke({ tool: "freehand", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })),
    ).toBe(true);
  });

  test("a note is meaningful with a single anchor", () => {
    expect(isMeaningfulStroke(stroke({ tool: "note", points: [{ x: 3, y: 3 }] }))).toBe(true);
  });
});

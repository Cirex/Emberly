import { describe, expect, test } from "bun:test";
import { optimizeStops, type TourStop } from "@/lib/tour-optimize";

let seq = 0;

/** Fixture builder — id uniqueness matters, content doesn't. */
function stop(unitNumber: string): TourStop {
  seq += 1;
  return { id: `s-${seq}`, unitNumber, note: "", isDone: false };
}

const centers = (entries: Record<string, [number, number]>) =>
  new Map(Object.entries(entries).map(([unit, [x, y]]) => [unit, { x, y }]));

describe("optimizeStops", () => {
  test("walks nearest-neighbor from the current first stop", () => {
    // From A(0,0): C(4,0) is nearer than B(10,0); from C the walk continues
    // to B — the greedy chain, not distance-from-start ordering.
    const stops = [stop("A"), stop("B"), stop("C")];
    const out = optimizeStops(stops, centers({ A: [0, 0], B: [10, 0], C: [4, 0] }));
    expect(out.map((s) => s.unitNumber)).toEqual(["A", "C", "B"]);
  });

  test("continues the walk from each chosen stop", () => {
    // From A(0,0): B(5,0) first; from B, D(6,4) beats C(0,9) on squared
    // distance (1+16=17 vs 25+81); C comes last.
    const stops = [stop("A"), stop("C"), stop("D"), stop("B")];
    const out = optimizeStops(stops, centers({ A: [0, 0], B: [5, 0], C: [0, 9], D: [6, 4] }));
    expect(out.map((s) => s.unitNumber)).toEqual(["A", "B", "D", "C"]);
  });

  test("keeps two or fewer stops untouched", () => {
    const stops = [stop("B"), stop("A")];
    const out = optimizeStops(stops, centers({ A: [0, 0], B: [100, 100] }));
    expect(out.map((s) => s.unitNumber)).toEqual(["B", "A"]);
  });

  test("appends stops without centroids at the end, order preserved", () => {
    const stops = [stop("A"), stop("X"), stop("B"), stop("Y"), stop("C")];
    const out = optimizeStops(stops, centers({ A: [0, 0], B: [9, 0], C: [3, 0] }));
    expect(out.map((s) => s.unitNumber)).toEqual(["A", "C", "B", "X", "Y"]);
  });

  test("returns the original order when fewer than two stops are locatable", () => {
    const stops = [stop("X"), stop("A"), stop("Y")];
    const out = optimizeStops(stops, centers({ A: [0, 0] }));
    expect(out.map((s) => s.unitNumber)).toEqual(["X", "A", "Y"]);
  });
});

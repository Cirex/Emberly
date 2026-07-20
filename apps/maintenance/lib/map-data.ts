import raw from "@/assets/map-data.json";

/** Normalized (0–1) rectangle over the plan page. */
export interface UnitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapRoad extends UnitRect {
  name: string | null;
  orientation: "horizontal" | "vertical";
}

interface RawBlock extends UnitRect {
  units: string[];
}

interface RawMapData {
  pageWidth: number;
  pageHeight: number;
  units: Record<string, UnitRect>;
  roads: MapRoad[];
  blocks: RawBlock[];
}

const DATA = raw as RawMapData;

/**
 * Page space = the unitmap.svg canvas (5347×3043). Unit rects, the drawn plan
 * and everything normalized (annotations) all share it; both files
 * are compiled from one generator run by scripts/build-map-scene.mjs, so the
 * boxes cannot drift from the drawing underneath them.
 */
export const PAGE_WIDTH = DATA.pageWidth;
export const PAGE_HEIGHT = DATA.pageHeight;

/** A unit placed in page coordinates. */
export interface PlacedUnit {
  number: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export const PLACED_UNITS: PlacedUnit[] = Object.entries(DATA.units).map(([number, r]) => {
  const x = r.x * PAGE_WIDTH;
  const y = r.y * PAGE_HEIGHT;
  const w = r.w * PAGE_WIDTH;
  const h = r.h * PAGE_HEIGHT;
  return { number, x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
});

export const MAP_ROADS: MapRoad[] = DATA.roads;

/** A building card in page coordinates — the rounded rect the plan draws. */
export interface PlacedBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  units: string[];
}

/** Corner radius of every building card, in page px (generator's rx). */
export const BLOCK_RADIUS = 5;

export const PLACED_BLOCKS: PlacedBlock[] = (DATA.blocks ?? []).map((b) => ({
  x: b.x * PAGE_WIDTH,
  y: b.y * PAGE_HEIGHT,
  w: b.w * PAGE_WIDTH,
  h: b.h * PAGE_HEIGHT,
  units: b.units,
}));

/** unit number → index into PLACED_BLOCKS, for clipping overlays to the card. */
export const UNIT_BLOCK: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  PLACED_BLOCKS.forEach((b, i) => {
    for (const n of b.units) m.set(n, i);
  });
  return m;
})();

export const UNIT_COUNT = PLACED_UNITS.length;

/** Case-insensitive substring match on unit number. */
export function matchUnits(query: string): Set<string> {
  const q = query.trim().toLowerCase();
  if (!q) return new Set();
  const out = new Set<string>();
  for (const u of PLACED_UNITS) {
    if (u.number.toLowerCase().includes(q)) out.add(u.number);
  }
  return out;
}

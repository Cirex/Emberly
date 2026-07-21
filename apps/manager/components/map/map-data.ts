import raw from "./map-data.json";

/**
 * Unit/block geometry for the property map — the manager cut of the
 * maintenance app's lib/map-data.ts.
 *
 * map-data.json is the SAME generated artifact the maintenance app bundles
 * (compiled from map-source/unitmap.svg by scripts/build-map-scene.mjs in one
 * run with @emberly/ui's map-scene.json, so the boxes cannot drift from the
 * drawing underneath them). It lives here as a copy because this feature owns
 * only components/map/**; when the generator next runs, both copies should be
 * refreshed — or better, the JSON promoted into @emberly/ui next to
 * map-scene.json.
 *
 * Trimmed against maintenance: no MAP_ROADS, no matchUnits (the manager
 * searches through @emberly/core's unitMatchesSearch over synced units).
 */

/** Normalized (0–1) rectangle over the plan page. */
interface UnitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RawBlock extends UnitRect {
  units: string[];
}

interface RawMapData {
  pageWidth: number;
  pageHeight: number;
  units: Record<string, UnitRect>;
  blocks: RawBlock[];
}

const DATA = raw as unknown as RawMapData;

/** Page space = the unitmap.svg canvas; everything on the map shares it. */
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

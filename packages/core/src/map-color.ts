import { CLASSIFICATION_TINT, STATUS_TINT } from "./tokens";

/**
 * The subset of a ResMan unit the map colorers read. Kept structural (rather
 * than importing each app's ResmanUnit) so this logic stays framework-free and
 * shared: any object with these fields — including both apps' ResmanUnit — is
 * assignable.
 */
export interface MapColorUnit {
  number: string;
  lease_status?: string | null;
  occupancy_status?: string | null;
  classification?: string | null;
  market_rent?: number | null;
}

export type MapMode = "occupancy" | "class" | "heatmap";

export interface RectColor {
  fill: string;
  stroke: string;
}

export interface LegendItem {
  label: string;
  color: string;
}

export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/(.)/g, "$1$1") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Green (low) → yellow → red (high), t in 0..1. */
function heatColor(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const rgb =
    c < 0.5
      ? lerp([51, 166, 102], [227, 178, 58], c * 2) // green → yellow
      : lerp([227, 178, 58], [209, 56, 46], (c - 0.5) * 2); // yellow → red
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

const OCCUPANCY_TINT: Record<string, string> = {
  Occupied: STATUS_TINT.ready,
  Vacant: STATUS_TINT.accentBlue,
  "Notice to Vacate": STATUS_TINT.warning,
  "Under Eviction": STATUS_TINT.blocked,
};

/**
 * ResMan files notice-given and under-eviction tenants under the single
 * occupancy "Notice" — lease_status is what tells them apart (same split the
 * Tenants screen filters on), so evictions get their own color on the map.
 */
export function occupancyGroup(u: MapColorUnit): keyof typeof OCCUPANCY_TINT | undefined {
  if (u.lease_status === "Under Eviction") return "Under Eviction";
  if (u.occupancy_status === "Notice") return "Notice to Vacate";
  if (u.occupancy_status === "Occupied" || u.occupancy_status === "Vacant") return u.occupancy_status;
  return undefined;
}

const CLASS_TINT: Record<string, string> = {
  ruby: CLASSIFICATION_TINT.ruby,
  diamond: CLASSIFICATION_TINT.diamond,
  legacy: CLASSIFICATION_TINT.legacy,
  lux: CLASSIFICATION_TINT.lux,
};

/** Build a number → {fill,stroke} map for the active mode. */
export function buildColorMap(mode: MapMode, units: MapColorUnit[]): Map<string, RectColor> {
  const map = new Map<string, RectColor>();

  if (mode === "occupancy") {
    for (const u of units) {
      const group = occupancyGroup(u);
      const tint = group ? OCCUPANCY_TINT[group] : undefined;
      if (tint) map.set(u.number, { fill: withAlpha(tint, 0.38), stroke: tint });
    }
    return map;
  }

  if (mode === "class") {
    for (const u of units) {
      const tint = u.classification ? CLASS_TINT[u.classification.toLowerCase()] : undefined;
      if (tint) map.set(u.number, { fill: withAlpha(tint, 0.42), stroke: tint });
    }
    return map;
  }

  // heatmap over market rent
  const rents = units.map((u) => u.market_rent).filter((r): r is number => typeof r === "number" && r > 0);
  if (rents.length === 0) return map;
  const min = Math.min(...rents);
  const max = Math.max(...rents);
  const span = max - min || 1;
  for (const u of units) {
    if (typeof u.market_rent === "number" && u.market_rent > 0) {
      const color = heatColor((u.market_rent - min) / span);
      map.set(u.number, { fill: color, stroke: color });
    }
  }
  return map;
}

export function legendFor(mode: MapMode, units: MapColorUnit[]): LegendItem[] {
  if (mode === "occupancy") {
    return [
      { label: "Occupied", color: STATUS_TINT.ready },
      { label: "Vacant", color: STATUS_TINT.accentBlue },
      { label: "Notice", color: STATUS_TINT.warning },
      { label: "Eviction", color: STATUS_TINT.blocked },
    ];
  }
  if (mode === "class") {
    // Only show classifications that actually appear.
    const present = new Set(units.map((u) => u.classification?.toLowerCase()).filter(Boolean));
    return (["ruby", "diamond", "legacy", "lux"] as const)
      .filter((k) => present.has(k))
      .map((k) => ({ label: k === "lux" ? "LUX" : k[0].toUpperCase() + k.slice(1), color: CLASS_TINT[k] }));
  }
  return [
    { label: "Lower rent", color: heatColor(0) },
    { label: "—", color: heatColor(0.5) },
    { label: "Higher", color: heatColor(1) },
  ];
}

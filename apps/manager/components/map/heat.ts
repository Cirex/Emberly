import {
  balanceHeatColor,
  unitMatchesCondition,
  withAlpha,
  type GroupUnit,
  type RectColor,
} from "@emberly/core";

/**
 * The delinquency heat lens: pure paint math over the synced units, kept free
 * of React/React Native imports so `bun test` can exercise it directly.
 *
 * Fill grading is @emberly/core's balanceHeatColor 5-step ramp with the
 * eviction override; this module only decides WHICH units get painted and at
 * what alpha over the drawn plan.
 */

/**
 * Heat fills sit over the vector site plan (which renders the unit numbers),
 * so they stay translucent — same reasoning as core's GROUP_FILL_ALPHA, a
 * touch higher because the ramp's low bands are pale.
 */
export const HEAT_FILL_ALPHA = 0.55;

/**
 * Eviction detection for the heat override. Routed through the shared
 * evictionFlag condition so the two lenses (heat and the Eviction group)
 * agree on what counts: delinquency_reason plus the occupancy/lease-status
 * "evict" scan.
 */
export function hasEvictionSignal(unit: GroupUnit): boolean {
  // evictionFlag never reads the clock; 0 keeps this call pure.
  return unitMatchesCondition(unit, { kind: "evictionFlag" }, 0);
}

export interface HeatPaintResult {
  /** unit number → paint. Current units (balance <= 0, no eviction) are absent:
   *  the plan's own near-white card IS the "Current" legend swatch. */
  colorMap: Map<string, RectColor>;
  /** Units carrying a positive balance (eviction included when it also owes). */
  delinquentCount: number;
  /** Units painted with the eviction override. */
  evictionCount: number;
}

/** Grade every unit's fill by balance owed; eviction overrides the ramp. */
export function buildHeatPaint(units: GroupUnit[]): HeatPaintResult {
  const colorMap = new Map<string, RectColor>();
  let delinquentCount = 0;
  let evictionCount = 0;

  for (const unit of units) {
    const balance = typeof unit.balance === "number" ? unit.balance : 0;
    const eviction = hasEvictionSignal(unit);
    if (balance > 0) delinquentCount += 1;
    if (eviction) evictionCount += 1;
    if (!eviction && balance <= 0) continue; // current — the plan shows through
    const hex = balanceHeatColor(balance, eviction);
    colorMap.set(unit.number, { fill: withAlpha(hex, HEAT_FILL_ALPHA), stroke: hex });
  }

  return { colorMap, delinquentCount, evictionCount };
}

/** Solid heat hex for a single unit — drives the callout tint. */
export function heatTint(unit: GroupUnit): string | undefined {
  const balance = typeof unit.balance === "number" ? unit.balance : 0;
  const eviction = hasEvictionSignal(unit);
  if (!eviction && balance <= 0) return undefined;
  return balanceHeatColor(balance, eviction);
}

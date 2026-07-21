import type { RectColor } from "./map-color";
import { occupancyGroup, type MapColorUnit } from "./map-color";

/**
 * User-defined map filter color groups — the return of the original app's
 * "filter color groups". A group is a name + color + AND-ed condition set;
 * groups paint matching units on the property map. List order is priority:
 * when a unit matches several groups, the FIRST match in the array wins.
 *
 * The condition vocabulary is deliberately a fixed library over synced unit
 * fields (no free-form query language): occupancy bucket, positive balance,
 * and lease-end windows. It grows by adding variants to GroupCondition.
 */

export interface GroupUnit extends MapColorUnit {
  number: string;
  balance?: number | null;
  lease_end_date?: string | null;
}

export type GroupCondition =
  /** occupancyGroup(unit) equals the given bucket ("Occupied" | "Vacant" | "Notice" | "Under Eviction"). */
  | { kind: "occupancy"; value: string }
  /** balance is present and strictly greater than zero. */
  | { kind: "balanceOverZero" }
  /** lease_end_date falls within [today, today + days]. */
  | { kind: "leaseEndsWithin"; days: number };

export interface MapFilterGroup {
  id: string;
  name: string;
  /** Fill hex; the stroke is derived by the painter. */
  colorHex: string;
  conditions: GroupCondition[];
  visible: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a date-only string as LOCAL midnight (UTC parsing shifts a day back). */
function localDateMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

export function unitMatchesCondition(unit: GroupUnit, cond: GroupCondition, nowMs: number): boolean {
  switch (cond.kind) {
    case "occupancy":
      return occupancyGroup(unit) === cond.value;
    case "balanceOverZero":
      return typeof unit.balance === "number" && unit.balance > 0;
    case "leaseEndsWithin": {
      if (!unit.lease_end_date) return false;
      const end = localDateMs(unit.lease_end_date);
      if (end === null) return false;
      return end >= nowMs - DAY_MS && end <= nowMs + cond.days * DAY_MS;
    }
  }
}

/** All conditions must match (AND). A group with no conditions matches nothing. */
export function unitMatchesGroup(unit: GroupUnit, group: MapFilterGroup, nowMs: number): boolean {
  if (group.conditions.length === 0) return false;
  return group.conditions.every((c) => unitMatchesCondition(unit, c, nowMs));
}

/** #RRGGBB fill → a slightly darkened stroke of the same hue. */
export function strokeFor(fillHex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(fillHex.trim());
  if (!m) return fillHex;
  const n = parseInt(m[1], 16);
  const dim = (v: number) => Math.max(0, Math.round(v * 0.72));
  const r = dim((n >> 16) & 0xff);
  const g = dim((n >> 8) & 0xff);
  const b = dim(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export interface GroupPaintResult {
  /** unit number → paint for the highest-priority matching VISIBLE group. */
  colorMap: Map<string, RectColor>;
  /** group id → matching unit count (counted for ALL groups, hidden included). */
  counts: Map<string, number>;
}

export function buildGroupPaint(groups: MapFilterGroup[], units: GroupUnit[], nowMs: number): GroupPaintResult {
  const colorMap = new Map<string, RectColor>();
  const counts = new Map<string, number>(groups.map((g) => [g.id, 0]));
  const paints = new Map(groups.map((g) => [g.id, { fill: g.colorHex, stroke: strokeFor(g.colorHex) }]));

  for (const unit of units) {
    for (const group of groups) {
      if (!unitMatchesGroup(unit, group, nowMs)) continue;
      counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
      // First VISIBLE match wins the paint; keep counting the rest.
      if (group.visible && !colorMap.has(unit.number)) {
        colorMap.set(unit.number, paints.get(group.id) as RectColor);
      }
    }
  }
  return { colorMap, counts };
}

/** The prebuilt starter groups (the mockup's defaults); ids are stable. */
export function defaultMapFilterGroups(): MapFilterGroup[] {
  return [
    {
      id: "prebuilt-delinquent",
      name: "Delinquent",
      colorHex: "#E24B4A",
      conditions: [{ kind: "balanceOverZero" }, { kind: "occupancy", value: "Occupied" }],
      visible: true,
    },
    {
      id: "prebuilt-lease-ending",
      name: "Lease ending 30d",
      colorHex: "#EF9F27",
      conditions: [{ kind: "leaseEndsWithin", days: 30 }],
      visible: true,
    },
    {
      id: "prebuilt-vacant",
      name: "Vacant",
      colorHex: "#378ADD",
      conditions: [{ kind: "occupancy", value: "Vacant" }],
      visible: true,
    },
  ];
}

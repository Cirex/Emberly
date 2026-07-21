import type { GroupCondition } from "@emberly/core";

/**
 * Pure helpers behind the color-group condition builder: the buildable kind
 * list, per-kind defaults, and i18n-ready summaries. Kept out of the sheet so
 * the vocabulary logic is unit-testable without rendering.
 *
 * The builder allows ONE condition per kind (conditions AND together, and a
 * second occupancy/band of the same kind can never both match), mirroring the
 * store's replace-by-kind setCondition semantics.
 */

export type ConditionKind = GroupCondition["kind"];

/** Every kind the engine evaluates, in the order the picker offers them. */
export const CONDITION_KINDS: ConditionKind[] = [
  "occupancy",
  "balanceOverZero",
  "balanceBand",
  "leaseEndsWithin",
  "availabilityIn",
  "evictionFlag",
];

/** Machine values (ResMan occupancy buckets) — never translated. */
export const OCCUPANCY_VALUES = ["Occupied", "Vacant", "Notice to Vacate", "Under Eviction"] as const;

export const LEASE_WINDOW_PRESETS = [30, 60, 90] as const;

/**
 * A sensible starting condition per kind; the user edits from there. The
 * availability default picks the first real value seen in the synced units so
 * the new row matches something immediately.
 */
export function defaultConditionFor(kind: ConditionKind, availabilities: string[]): GroupCondition {
  switch (kind) {
    case "occupancy":
      return { kind, value: "Occupied" };
    case "balanceOverZero":
      return { kind };
    case "balanceBand":
      return { kind, min: 0, max: null };
    case "leaseEndsWithin":
      return { kind, days: 30 };
    case "availabilityIn":
      return { kind, values: availabilities.length > 0 ? [availabilities[0]] : ["Available"] };
    case "evictionFlag":
      return { kind };
  }
}

/**
 * Distinct availability texts across the synced units, trimmed, first-seen
 * casing kept, sorted — the chip vocabulary for availabilityIn.
 */
export function distinctAvailabilities(units: { availability?: string | null }[]): string[] {
  const seen = new Map<string, string>();
  for (const u of units) {
    const raw = u.availability?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export interface ConditionSummary {
  /** i18n key under mapGroups.summary.* */
  key: string;
  params?: Record<string, string | number>;
}

/** i18n key + params describing one condition, for row chips and summaries. */
export function conditionSummary(c: GroupCondition): ConditionSummary {
  switch (c.kind) {
    case "occupancy":
      return { key: "occupancy", params: { value: c.value } };
    case "balanceOverZero":
      return { key: "balanceOverZero" };
    case "balanceBand":
      return c.max === null
        ? { key: "balanceOver", params: { min: c.min } }
        : { key: "balanceBand", params: { min: c.min, max: c.max } };
    case "leaseEndsWithin":
      return { key: "leaseEndsWithin", params: { count: c.days } };
    case "availabilityIn":
      return { key: "availabilityIn", params: { values: c.values.join(", ") } };
    case "evictionFlag":
      return { key: "evictionFlag" };
  }
}

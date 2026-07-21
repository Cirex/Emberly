import { layoutLabel, type GroupCondition, type GroupUnit } from "@emberly/core";

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
  "classificationIn",
  "layoutIn",
  "evictionFlag",
];

/** Machine values (ResMan occupancy buckets) — never translated. */
export const OCCUPANCY_VALUES = ["Occupied", "Vacant", "Notice to Vacate", "Under Eviction"] as const;

export const LEASE_WINDOW_PRESETS = [30, 60, 90] as const;

/** The chip vocabularies drawn from the synced units, one list per data-driven kind. */
export interface ConditionVocabulary {
  availabilities: string[];
  classifications: string[];
  layouts: string[];
}

/**
 * A sensible starting condition per kind; the user edits from there. The
 * data-driven kinds pick the first real value seen in the synced units so
 * the new row matches something immediately.
 */
export function defaultConditionFor(kind: ConditionKind, vocab: ConditionVocabulary): GroupCondition {
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
      return { kind, values: vocab.availabilities.length > 0 ? [vocab.availabilities[0]] : ["Available"] };
    case "classificationIn":
      return { kind, values: vocab.classifications.length > 0 ? [vocab.classifications[0]] : [""] };
    case "layoutIn":
      return { kind, values: vocab.layouts.length > 0 ? [vocab.layouts[0]] : ["1x1"] };
    case "evictionFlag":
      return { kind };
  }
}

/** Distinct trimmed values, first-seen casing kept, sorted. */
function distinct(values: (string | null | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const raw = value?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** The chip vocabularies for the data-driven kinds, from the synced units. */
export function buildConditionVocabulary(units: GroupUnit[]): ConditionVocabulary {
  return {
    availabilities: distinct(units.map((u) => u.availability)),
    classifications: distinct(units.map((u) => u.classification)),
    // "2x1.5" sorts numerically-ish via localeCompare's numeric option below;
    // plain sort is fine for the handful of layouts a property has.
    layouts: distinct(units.map((u) => layoutLabel(u))).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
  };
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
    case "classificationIn":
      return { key: "classificationIn", params: { values: c.values.join(", ") } };
    case "layoutIn":
      return { key: "layoutIn", params: { values: c.values.join(", ") } };
    case "evictionFlag":
      return { key: "evictionFlag" };
  }
}

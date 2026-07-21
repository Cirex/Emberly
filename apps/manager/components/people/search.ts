import type { PeopleIndexEntry } from "@/lib/api/people";

/**
 * The directory matcher — pure, synchronous, and run over the cached index, so
 * search answers on the keystroke and works with no network.
 *
 * Four things match, and results are GROUPED by what matched, because the
 * question behind each is different:
 *
 *   People  — first name, last name, or "first last", case-insensitive
 *             substring; also a phone number, compared digits-only so
 *             "9015550112", "(901) 555-0112" and "555-0112" all land.
 *   Plates  — license plate, compared with spaces/dashes stripped and
 *             case-folded, optionally prefixed by its state ("TN7REY220").
 *             "Whose car is this" is a real question with a real answer.
 *   Units   — the unit number itself, PLUS the units of everyone matched
 *             above: searching a surname should show you their unit.
 *
 * A blank query is not an error — it yields the whole directory in the People
 * group (the iPad's resting left pane), with no plate or unit noise.
 */

export type PeopleScope = "all" | "people" | "plates" | "units";

export const PEOPLE_SCOPES: PeopleScope[] = ["all", "people", "plates", "units"];

/** A plate hit, carrying just enough to answer "whose car is this". */
export interface PlateHit {
  /** Stable list key: one person can hold several plates. */
  key: string;
  plate: string;
  state: string;
  personLeaseId: string;
  name: string;
  unitNumber: string;
}

/** A unit hit — the unit number plus who is on it. */
export interface UnitHit {
  unitNumber: string;
  residentCount: number;
  /** The primary resident's name when there is one, else the first resident. */
  primaryName: string;
}

export interface PeopleSearchResults {
  /** The normalized query the results were computed from. */
  query: string;
  people: PeopleIndexEntry[];
  plates: PlateHit[];
  units: UnitHit[];
  counts: Record<PeopleScope, number>;
}

/** Lowercased, whitespace-collapsed. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Digits only — how phone numbers and unit numbers are compared. */
export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

/** Uppercased with spaces, dashes and dots removed — how plates are compared. */
export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[\s.\-·]+/g, "");
}

/** The display name; falls back to whichever half exists. */
export function fullName(entry: { firstName: string; lastName: string }): string {
  return `${entry.firstName} ${entry.lastName}`.trim().replace(/\s+/g, " ");
}

/** Name match: first, last, or "first last" contains the query. */
export function matchesName(entry: PeopleIndexEntry, normalized: string): boolean {
  if (normalized === "") return true;
  const first = entry.firstName.toLowerCase();
  const last = entry.lastName.toLowerCase();
  return (
    first.includes(normalized) ||
    last.includes(normalized) ||
    `${first} ${last}`.trim().includes(normalized)
  );
}

/**
 * Phone match, digits-only both sides. Two digits is not a search — it would
 * match most of the property — so short numeric queries are left to the unit
 * and name matchers.
 */
export function matchesPhone(entry: PeopleIndexEntry, queryDigits: string): boolean {
  if (queryDigits.length < 3) return false;
  return entry.phones.some((phone) => digitsOnly(phone).includes(queryDigits));
}

/** Unit match: substring on the raw number and on its digits ("327" → "0327"). */
export function matchesUnit(unitNumber: string, normalized: string, queryDigits: string): boolean {
  if (unitNumber === "") return false;
  if (normalized !== "" && unitNumber.toLowerCase().includes(normalized)) return true;
  if (queryDigits.length > 0) {
    const unitDigits = digitsOnly(unitNumber);
    if (unitDigits !== "" && unitDigits.includes(queryDigits)) return true;
  }
  return false;
}

/** Plate match: case- and separator-insensitive, with or without the state. */
export function matchesPlate(
  vehicle: { plate: string; state: string },
  normalizedPlateQuery: string,
): boolean {
  if (normalizedPlateQuery === "") return false;
  const plate = normalizePlate(vehicle.plate);
  if (plate === "") return false;
  return (
    plate.includes(normalizedPlateQuery) ||
    `${normalizePlate(vehicle.state)}${plate}`.includes(normalizedPlateQuery)
  );
}

/** Build the unit group from matched people plus any direct unit-number hits. */
function unitHits(
  index: PeopleIndexEntry[],
  matchedUnits: Set<string>,
  normalized: string,
  queryDigits: string,
): UnitHit[] {
  const units = new Set(matchedUnits);
  if (normalized !== "") {
    for (const entry of index) {
      if (matchesUnit(entry.unitNumber, normalized, queryDigits)) units.add(entry.unitNumber);
    }
  }
  const byUnit = new Map<string, PeopleIndexEntry[]>();
  for (const entry of index) {
    if (!units.has(entry.unitNumber)) continue;
    const list = byUnit.get(entry.unitNumber) ?? [];
    list.push(entry);
    byUnit.set(entry.unitNumber, list);
  }
  return [...byUnit.entries()]
    .map(([unitNumber, residents]) => ({
      unitNumber,
      residentCount: residents.length,
      primaryName: fullName(residents.find((r) => r.isPrimary) ?? residents[0]),
    }))
    .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber));
}

/**
 * Search the cached index. `index` is expected pre-sorted by surname (the API
 * returns it that way) — matched people keep that order.
 */
export function searchPeople(index: PeopleIndexEntry[], query: string): PeopleSearchResults {
  const normalized = normalizeQuery(query);
  const queryDigits = digitsOnly(normalized);
  const plateQuery = normalizePlate(normalized);

  if (normalized === "") {
    return {
      query: "",
      people: index,
      plates: [],
      units: [],
      counts: { all: index.length, people: index.length, plates: 0, units: 0 },
    };
  }

  const people: PeopleIndexEntry[] = [];
  const plates: PlateHit[] = [];
  const matchedUnits = new Set<string>();

  for (const entry of index) {
    const nameHit = matchesName(entry, normalized) || matchesPhone(entry, queryDigits);
    if (nameHit) {
      people.push(entry);
      if (entry.unitNumber !== "") matchedUnits.add(entry.unitNumber);
    }
    for (const vehicle of entry.vehicles) {
      if (!matchesPlate(vehicle, plateQuery)) continue;
      plates.push({
        key: `${entry.personLeaseId}:${vehicle.plate}`,
        plate: vehicle.plate,
        state: vehicle.state,
        personLeaseId: entry.personLeaseId,
        name: fullName(entry),
        unitNumber: entry.unitNumber,
      });
      if (entry.unitNumber !== "") matchedUnits.add(entry.unitNumber);
    }
  }

  const units = unitHits(index, matchedUnits, normalized, queryDigits);
  return {
    query: normalized,
    people,
    plates,
    units,
    counts: {
      all: people.length + plates.length + units.length,
      people: people.length,
      plates: plates.length,
      units: units.length,
    },
  };
}

/** Directory totals for the header line ("811 residents · 1,102 vehicles"). */
export function directoryTotals(index: PeopleIndexEntry[]): {
  residents: number;
  primaries: number;
  householdMembers: number;
  vehicles: number;
} {
  let primaries = 0;
  let vehicles = 0;
  for (const entry of index) {
    if (entry.isPrimary) primaries += 1;
    vehicles += entry.vehicles.length;
  }
  return {
    residents: index.length,
    primaries,
    householdMembers: index.length - primaries,
    vehicles,
  };
}

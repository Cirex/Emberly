/**
 * Port of KrakenCore/Services/MLGW/MLGWParser+UnitMatching.swift (pure subset).
 *
 * The account → unit address heuristic. Swift built the lookup from a SwiftData
 * `PropertyUnit` fetch; here `buildUnitLookup` takes a plain `PropertyUnitInput[]`
 * (the job layer supplies the units). `resolveAccountUnit` is the top-level
 * result the row mapper wants: `{ resman_unit_id, unit_number, is_house_account }`.
 *
 * A lookup key maps to a unit only when exactly one unit claims it (ambiguous
 * addresses/unit-numbers are dropped), matching Swift's `entry.value.count == 1`.
 */

import { firstMatch, nilIfBlank, replacingMatches } from "../text";
import { isHouseAccount, sanitizedServiceAddress } from "./model-keys";

/** The `PropertyUnit` fields the matcher reads (SwiftData model → plain input). */
export interface PropertyUnitInput {
  unitId: string;
  number: string;
  street: string;
  city: string;
  state: string;
}

/** The account's resolved unit linkage columns. */
export interface ResolvedAccountUnit {
  resman_unit_id: string;
  unit_number: string;
  is_house_account: boolean;
}

/** Pure port of `makeUnitLookup(propertyId:context:)` — takes the units directly. */
export function buildUnitLookup(units: PropertyUnitInput[]): Map<string, PropertyUnitInput> {
  const groupedUnits = new Map<string, PropertyUnitInput[]>();

  const add = (key: string, unit: PropertyUnitInput): void => {
    if (key.length === 0) return;
    const bucket = groupedUnits.get(key) ?? [];
    if (!bucket.includes(unit)) {
      bucket.push(unit);
      groupedUnits.set(key, bucket);
    }
  };

  for (const unit of units) {
    for (const address of unitAddressCandidates(unit)) {
      add(normalizedUnitLookupAddress(address), unit);
    }
    const numberKey = unitNumberLookupKeyFromUnitNumber(unit.number);
    if (numberKey !== null) add(numberKey, unit);
  }

  const lookup = new Map<string, PropertyUnitInput>();
  for (const [key, bucket] of groupedUnits) {
    if (bucket.length === 1) lookup.set(key, bucket[0]);
  }
  return lookup;
}

/** Pure port of `matchedUnit(for:lookup:)`. */
export function matchedUnit(
  serviceAddress: string,
  lookup: Map<string, PropertyUnitInput>,
): PropertyUnitInput | null {
  if (isHouseAccount(serviceAddress)) return null;
  const key = normalizedUnitLookupAddress(serviceAddress);
  if (key.length > 0) {
    const unit = lookup.get(key);
    if (unit !== undefined) return unit;
  }
  const unitNumberKey = unitNumberLookupKeyFromServiceAddress(serviceAddress);
  if (unitNumberKey === null) return null;
  return lookup.get(unitNumberKey) ?? null;
}

/**
 * The account→unit linkage the row mapper needs, combining the Swift
 * `isHouseAccount` / `matchedUnit` branch of `importBillsCooperatively`.
 */
export function resolveAccountUnit(
  serviceAddress: string,
  lookup: Map<string, PropertyUnitInput>,
): ResolvedAccountUnit {
  if (isHouseAccount(serviceAddress)) {
    return { resman_unit_id: "", unit_number: "", is_house_account: true };
  }
  const unit = matchedUnit(serviceAddress, lookup);
  if (unit !== null) {
    return { resman_unit_id: unit.unitId, unit_number: unit.number, is_house_account: false };
  }
  return { resman_unit_id: "", unit_number: "", is_house_account: false };
}

function unitAddressCandidates(unit: PropertyUnitInput): string[] {
  const streetAddress = unit.street.trim();
  const formattedAddress = [unit.street, unit.city, unit.state]
    .map((value) => nilIfBlank(value))
    .filter((value): value is string => value !== null)
    .join(", ")
    .trim();

  const candidates: string[] = [];
  if (streetAddress.length > 0) candidates.push(streetAddress);
  if (formattedAddress.length > 0) candidates.push(formattedAddress);

  const suffix = unitSuffix(unit.number);
  if (suffix !== null && streetAddress.length > 0 && !addressContainsUnitDesignator(streetAddress)) {
    candidates.push(`${streetAddress} Apt ${suffix}`);
    candidates.push(`${streetAddress} #${suffix}`);
  }
  return candidates;
}

function unitSuffix(unitNumber: string): string | null {
  const trimmed = unitNumber.trim();
  if (trimmed.length === 0) return null;
  const dash = trimmed.lastIndexOf("-");
  const suffix = dash >= 0 ? trimmed.slice(dash + 1) : trimmed;
  const cleaned = suffix.replace(/^(?:apt|apartment|unit|#)\s*/i, "").trim();
  return cleaned.length === 0 ? null : cleaned;
}

function unitNumberLookupKeyFromUnitNumber(unitNumber: string): string | null {
  const cleaned = unitNumber.trim();
  if (cleaned.length === 0) return null;
  const building = firstMatch(cleaned, "^\\s*([0-9]{1,6})\\b");
  const suffix = unitSuffix(cleaned);
  if (building === null || suffix === null) return null;
  return unitNumberLookupKey(building, suffix);
}

function unitNumberLookupKeyFromServiceAddress(serviceAddress: string): string | null {
  const cleaned = sanitizedServiceAddress(serviceAddress);
  const pattern =
    "^\\s*([0-9]{1,6})\\b.*(?:\\b(?:apt|apartment|unit|suite|ste)\\.?\\s*#?\\s*|#\\s*)([A-Za-z0-9-]+)\\s*$";
  const match = new RegExp(pattern, "i").exec(cleaned);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return unitNumberLookupKey(match[1], match[2]);
}

function unitNumberLookupKey(building: string, suffix: string): string | null {
  const buildingDigits = building.replace(/[^0-9]/g, "");
  const suffixClean = suffix
    .replace(/^(?:apt|apartment|unit|#)\s*/i, "")
    .trim()
    .toUpperCase();
  if (buildingDigits.length === 0 || suffixClean.length === 0) return null;
  return `unit-number:${buildingDigits}|${suffixClean}`;
}

function addressContainsUnitDesignator(value: string): boolean {
  return /(?:\bapt\b|\bapartment\b|\bunit\b|\bsuite\b|\bste\b|#)\s*\S+\s*$/i.test(value);
}

const UNIT_LOOKUP_REPLACEMENTS: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "ave",
  av: "ave",
  drive: "dr",
  drv: "dr",
  road: "rd",
  court: "ct",
  place: "pl",
  lane: "ln",
  boulevard: "blvd",
  circle: "cir",
  terrace: "ter",
  parkway: "pkwy",
  highway: "hwy",
};

function normalizedUnitLookupAddress(value: string): string {
  let cleaned = foldDiacriticsAndWidth(sanitizedServiceAddress(value)).toLowerCase().trim();
  cleaned = cleaned.replace(/\b(?:apartment|apt|unit|suite|ste)\.?\s*#?\s*/g, " apt ");
  cleaned = cleaned.replace(/#\s*/g, " apt ");
  cleaned = replacingMatches(cleaned, "[^\\p{L}\\p{N} ]+", " ", "u");
  cleaned = cleaned.replace(/\s+/g, " ");
  return cleaned
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) => UNIT_LOOKUP_REPLACEMENTS[token] ?? token)
    .join(" ");
}

/** NFKD fold + combining-mark strip, approximating Swift diacritic/width folding. */
function foldDiacriticsAndWidth(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

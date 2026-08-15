/**
 * Resident + per-person tab upsert mappers — pure ports of `upsertResidents`
 * (and the per-resident `replaceChildren` tab merges) in
 * KrakenCore/Services/ResMan/ResManUnitDetailSync.swift, reading the identity
 * dict shape produced by `buildResidentDict` /
 * `scrapeResidentDictWithTabs` in ResManUnitDetailScraper.swift.
 *
 * The Swift `upsertResidents` mutated SwiftData `Resident` objects and their
 * cascade-owned child relationships (vehicles/employment/insurance/addresses/
 * alternate-contacts). Here each becomes a pure function returning row DTOs
 * (`ResmanResidentRow` + the five lease-tab row types), all keyed on the
 * resident's `resman_person_lease_id`. The JOB layer calls `upsertMirror` and
 * owns delete-missing (scoped per lease / per person-lease), so — matching the
 * Swift never-delete-on-empty guards — this returns empty arrays for empty
 * input and simply omits tab rows whose source key is absent from the dict.
 *
 * Synthetic child PKs mirror the Swift `replaceChildren` id format
 * (`"<idPrefix>_<index>"` where `idPrefix = "<personLeaseId>_<tab>"`), assigned
 * positionally. Swift additionally re-used ids across syncs via a content-key
 * merge against the live DB rows; that is impossible statelessly, so ids are
 * purely positional here (see TODO in the file the integrator wires).
 */

import { titleCaseName, normalizeState } from "../normalize";
import { numOrNull, parseLedgerDate, str, boolValue } from "./parse";
import type {
  ResmanResidentRow,
  ResmanLeaseVehicleRow,
  ResmanLeaseEmploymentRow,
  ResmanLeaseInsuranceRow,
  ResmanLeaseAddressRow,
  ResmanLeaseAlternateContactRow,
} from "./types";

/** Grouped output of `mapResidents` — one flat array per target mirror table. */
export interface MappedResidents {
  residents: ResmanResidentRow[];
  vehicles: ResmanLeaseVehicleRow[];
  employment: ResmanLeaseEmploymentRow[];
  insurance: ResmanLeaseInsuranceRow[];
  addresses: ResmanLeaseAddressRow[];
  alternateContacts: ResmanLeaseAlternateContactRow[];
}

// MARK: - Cell coercers (Swift `r["Label"] as? String ?? …` idioms)

/**
 * First candidate key whose value is a string, else "". Port of the Swift
 * `r["A"] as? String ?? r["B"] as? String ?? ""` cell-read idiom.
 */
function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** First candidate key that is present (non-undefined), for `numOrNull`. */
function pickAny(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Vehicle `Year` cell: a string as-is, an integer stringified, else "".
 * Port of `r["Year"] as? String ?? (r["Year"] as? Int).map { "\($0)" } ?? ""`.
 */
function yearCell(row: Record<string, unknown>): string {
  const value = row["Year"];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return "";
}

/**
 * "Emergency Contact" cell → bool if boolean, else string "yes"
 * (case-insensitive), else false. Port of the Swift alternate-contact idiom.
 */
function emergencyCell(row: Record<string, unknown>): boolean {
  const value = row["Emergency Contact"];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "yes";
  return false;
}

/** Coerce a scrape-dict value to `string[]` (Swift `as? [String] ?? []`). */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (!value.every((entry) => typeof entry === "string")) return [];
  return value as string[];
}

// MARK: - Per-tab row mappers (shared with leases.ts)

/**
 * Map the `vehicles` tab rows for one person. Cell keys and fallbacks mirror the
 * Swift vehicle `replaceChildren` block. Ids are `"<personLeaseId>_veh_<i>"`.
 */
export function mapVehicleRows(
  rows: Record<string, unknown>[],
  personLeaseId: string,
): ResmanLeaseVehicleRow[] {
  return rows.map((row, index) => ({
    resman_vehicle_id: `${personLeaseId}_veh_${index}`,
    resman_person_lease_id: personLeaseId,
    make: pick(row, "Make"),
    model: pick(row, "Model"),
    year: yearCell(row),
    color: pick(row, "Color"),
    license_plate: pick(row, "License Plate", "Plate #"),
    license_plate_state: normalizeState(pick(row, "State", "Plate State")),
    // The Vehicles tab carries a permit (decal) number and a free-text note,
    // both of which were parsed and then dropped. It carries no parking-space
    // field at all, which is why `parking_spot` is not read here — see the
    // column note in docs/Database.md.
    permit_number: pick(row, "Permit Number"),
    notes: pick(row, "Notes"),
  }));
}

/**
 * Map the `employment` tab rows for one person (the Swift dict already
 * concatenates the Employment + Other Income tabs into `employment`). Ids are
 * `"<personLeaseId>_emp_<i>"`.
 */
export function mapEmploymentRows(
  rows: Record<string, unknown>[],
  personLeaseId: string,
): ResmanLeaseEmploymentRow[] {
  return rows.map((row, index) => ({
    resman_employment_id: `${personLeaseId}_emp_${index}`,
    resman_person_lease_id: personLeaseId,
    employer_name: pick(row, "Employer", "Source"),
    position: pick(row, "Position", "Title"),
    phone: pick(row, "Phone"),
    // Set only on the tab's other-income records (see `parseEmploymentTab`);
    // on a job it stays empty, because the Employer cell already holds it.
    other_income_source: pick(row, "Other Income Source"),
    monthly_income: numOrNull(pickAny(row, "Monthly Income", "Income")),
    other_income: numOrNull(pickAny(row, "Other Income", "Amount")),
    start_date: parseLedgerDate(pick(row, "Start Date")),
  }));
}

/**
 * Map the `insurance` tab rows for one person. Ids are
 * `"<personLeaseId>_ins_<i>"`.
 */
export function mapInsuranceRows(
  rows: Record<string, unknown>[],
  personLeaseId: string,
): ResmanLeaseInsuranceRow[] {
  return rows.map((row, index) => ({
    resman_insurance_id: `${personLeaseId}_ins_${index}`,
    resman_person_lease_id: personLeaseId,
    provider: pick(row, "Provider", "Company"),
    policy_number: pick(row, "Policy #", "Policy Number"),
    policy_type: pick(row, "Type"),
    status: pick(row, "Status"),
    start_date: parseLedgerDate(pick(row, "Start Date")),
    end_date: parseLedgerDate(pick(row, "End Date", "Expiration Date")),
    coverage_amount: numOrNull(pickAny(row, "Amount", "Coverage")),
  }));
}

/**
 * Map the `addresses` tab rows for one person. Ids are
 * `"<personLeaseId>_addr_<i>"`.
 */
export function mapAddressRows(
  rows: Record<string, unknown>[],
  personLeaseId: string,
): ResmanLeaseAddressRow[] {
  return rows.map((row, index) => ({
    resman_address_id: `${personLeaseId}_addr_${index}`,
    resman_person_lease_id: personLeaseId,
    address_type: pick(row, "Type", "Address Type"),
    street: pick(row, "Address", "Street"),
    city: pick(row, "City"),
    state: normalizeState(pick(row, "State")),
    postal_code: pick(row, "Zip", "Postal Code"),
    country: pick(row, "Country"),
    start_date: parseLedgerDate(pick(row, "Start Date")),
    end_date: parseLedgerDate(pick(row, "End Date")),
  }));
}

/**
 * Map the `alternateContacts` tab rows for one person. Ids are
 * `"<personLeaseId>_ac_<i>"`.
 */
export function mapAlternateContactRows(
  rows: Record<string, unknown>[],
  personLeaseId: string,
): ResmanLeaseAlternateContactRow[] {
  return rows.map((row, index) => ({
    resman_contact_id: `${personLeaseId}_ac_${index}`,
    resman_person_lease_id: personLeaseId,
    name: pick(row, "Name"),
    relationship: pick(row, "Relationship"),
    phone: pick(row, "Phone"),
    email: pick(row, "Email"),
    is_emergency_contact: emergencyCell(row),
  }));
}

/** Read a nested `[[String: Any]]` tab array off a dict, or null when absent. */
function tabRows(dict: Record<string, unknown>, key: string): Record<string, unknown>[] | null {
  const value = dict[key];
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null,
  );
}

// MARK: - Residents

/**
 * Port of `upsertResidents`. Maps the scraped residents array into resident
 * rows plus their per-person tab rows, all keyed on `resman_person_lease_id`.
 *
 * `resman_person_lease_id` is the stable per-person-per-lease UUID from the
 * `/Residents/Detail/{id}` URL; when a row lacks one, the Swift synthetic
 * fallback `"<leaseId>_r<index>"` is used (matching `upsertResidents`). Tab rows
 * are emitted only when the corresponding key (`vehicles`/`employment`/
 * `insurance`/`addresses`/`alternateContacts`) is present in the resident dict —
 * an absent key means "not fetched this sync" and yields no rows (the job must
 * not delete-missing for tab types it did not fetch).
 *
 * Returns all-empty arrays for empty input (never-delete-on-empty is the job's
 * decision), mirroring the Swift `guard !rows.isEmpty else { return }`.
 */
export function mapResidents(
  residents: Record<string, unknown>[],
  ctx: { leaseId: string },
): MappedResidents {
  const out: MappedResidents = {
    residents: [],
    vehicles: [],
    employment: [],
    insurance: [],
    addresses: [],
    alternateContacts: [],
  };
  if (residents.length === 0) return out;

  residents.forEach((row, index) => {
    const rawPlid = typeof row["personLeaseId"] === "string" ? (row["personLeaseId"] as string) : null;
    const personLeaseId = rawPlid ?? `${ctx.leaseId}_r${index}`;

    const birthdateRaw = row["birthdate"];
    const birthdate = typeof birthdateRaw === "string" ? parseLedgerDate(birthdateRaw) : null;

    out.residents.push({
      resman_person_lease_id: personLeaseId,
      resman_person_id: str(row, "personId"),
      resman_lease_id: ctx.leaseId,
      first_name: titleCaseName(str(row, "firstName")) ?? "",
      last_name: titleCaseName(str(row, "lastName")) ?? "",
      email: str(row, "email"),
      phone_numbers: stringArray(row["phoneNumbers"]),
      gender: str(row, "gender"),
      birthdate,
      household_status: str(row, "householdStatus"),
      drivers_license: str(row, "driversLicense"),
      drivers_license_state: normalizeState(str(row, "driversLicenseState")),
      language: str(row, "language"),
      identification: str(row, "identification"),
      is_primary: boolValue(row["isPrimary"]),
      raw: row,
    });

    const veh = tabRows(row, "vehicles");
    if (veh) out.vehicles.push(...mapVehicleRows(veh, personLeaseId));
    const emp = tabRows(row, "employment");
    if (emp) out.employment.push(...mapEmploymentRows(emp, personLeaseId));
    const ins = tabRows(row, "insurance");
    if (ins) out.insurance.push(...mapInsuranceRows(ins, personLeaseId));
    const addr = tabRows(row, "addresses");
    if (addr) out.addresses.push(...mapAddressRows(addr, personLeaseId));
    const ac = tabRows(row, "alternateContacts");
    if (ac) out.alternateContacts.push(...mapAlternateContactRows(ac, personLeaseId));
  });

  return out;
}

/**
 * Shared contracts for the ResMan unit-detail deep scrape — the FOUNDATION types
 * every scraper/mapper/job module codes against.
 *
 * Ports:
 *   - Scrape-result dicts from KrakenCore/Services/ResMan/ResManUnitDetailScraper.swift
 *     (`UnitScrapeResult`, `BuildingFloorplans`, `BuildingLookup`, `FloorplanLookup`).
 *   - Row DTO interfaces for the 8 target mirror tables. These replace the Swift
 *     SwiftData `@Model` classes (KrakenCore/Models/{Lease,Transaction,LeaseResident,
 *     LeaseVehicle,LeaseEmployment,LeaseInsurance,LeaseAddress,LeaseAlternateContact}.swift):
 *     the Swift `upsert*` mutated ModelContext objects, whereas here the pure
 *     mappers return these plain row objects and the JOB layer calls `upsertMirror`.
 *
 * Column/type convention (faithful to the Swift model optionality):
 *   - PK / FK id columns and Swift non-optional `String` fields → `string`
 *     (the mappers coerce missing values to "" via `str(...)`).
 *   - Swift `Date?` (date columns) → `string | null`, ISO `yyyy-MM-dd` or null.
 *   - Swift `Double?` (numeric columns) → `number | null`.
 *   - Swift `Bool` → `boolean`; `[String]` phone list → `string[]`.
 *   - the untyped scrape dict is preserved under `raw` as `unknown`.
 */

// MARK: - Scrape-result dicts (ResManUnitDetailScraper.swift)

/** Result of a per-unit scrape: the unit id plus its untyped `[String: Any]` dict. */
export interface UnitScrapeResult {
  unitId: string;
  data: Record<string, unknown>;
}

/** Building-name lookup entry (JSON keys `BuildingID`, `Name` — no CodingKeys remap). */
export interface BuildingLookup {
  BuildingID: string;
  Name: string;
}

/**
 * Floorplan (ResMan "unit type") lookup entry. Property names match the decoded
 * Swift struct; the source JSON keys differ where noted (Swift `CodingKeys`):
 *   floorplanId ← JSON `UnitTypeID`.
 */
export interface FloorplanLookup {
  /** JSON `UnitTypeID`. */
  floorplanId: string;
  Name: string;
  Description: string | null;
  AllowsMultipleLeases: boolean;
  SquareFootage: number | null;
  TotalUnits: number | null;
  NameAndDescription: string | null;
}

/**
 * `/Units/GetBuildingsAndUnitTypes` decoded payload. Property names match the
 * decoded Swift struct; source JSON keys differ where noted (Swift `CodingKeys`):
 *   floorplans ← JSON `unitTypes`.
 */
export interface BuildingFloorplans {
  buildings: BuildingLookup[];
  /** JSON `unitTypes`. */
  floorplans: FloorplanLookup[];
}

// MARK: - Row DTOs (one per target mirror table)

/** resman_transactions — PK `resman_ledger_entry_id`. Port of Transaction.swift. */
export interface ResmanTransactionRow {
  resman_ledger_entry_id: string;
  resman_property_id: string;
  resman_unit_id: string;
  resman_lease_id: string;
  transaction_id: string;
  transaction_type: string;
  date: string | null;
  reference: string;
  batch: string;
  batch_id: string;
  category: string;
  ledger_description: string;
  notes: string;
  charges: number | null;
  credits: number | null;
  balance: number | null;
  /** Position in ResMan's ledger table: 0 = oldest (bottom row), higher = newer.
   *  The ledger is a running balance, so this order — not the date — is what
   *  makes the balance column read correctly. */
  ledger_sequence: number;
}

/** resman_leases — PK `resman_lease_id`. Port of Lease.swift. */
export interface ResmanLeaseRow {
  resman_lease_id: string;
  unit_lease_group_id: string;
  resman_property_id: string;
  resman_unit_id: string;
  unit_number: string;
  status: string;
  approval_status: string;
  /** When the application was approved, from the Activity Log. */
  approved_date: string | null;
  /** The staff member the Activity Log credits with the approval. */
  approved_by: string;
  application_date: string | null;
  signed_date: string | null;
  start_date: string | null;
  end_date: string | null;
  move_in_date: string | null;
  move_out_date: string | null;
  leasing_agent: string;
  renewal_date: string | null;
  notice_given_date: string | null;
  market_rent: number | null;
  resident_rent: number | null;
  hap_rent: number | null;
  monthly_charge: number | null;
  balance: number | null;
  collection_balance: number | null;
  reason_for_leaving: string;
  is_current_lease: boolean;
  is_most_recent_lease: boolean;
  raw: unknown;
  /** When this lease's children (ledger, residents, tabs) were last fully
   *  synced. NULL means never — a terminal lease without it is a skeleton and
   *  must not be skipped as "already captured". */
  deep_synced_at?: string | null;
}

/** resman_residents — PK `resman_person_lease_id`. Port of LeaseResident.swift. */
export interface ResmanResidentRow {
  resman_person_lease_id: string;
  resman_person_id: string;
  resman_lease_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_numbers: string[];
  gender: string;
  birthdate: string | null;
  household_status: string;
  drivers_license: string;
  drivers_license_state: string;
  language: string;
  identification: string;
  is_primary: boolean;
  raw: unknown;
}

/** resman_lease_vehicles — PK `resman_vehicle_id`. Port of LeaseVehicle.swift. */
export interface ResmanLeaseVehicleRow {
  resman_vehicle_id: string;
  resman_person_lease_id: string;
  make: string;
  model: string;
  /** Swift `LeaseVehicle.year` is a `String` (free-text). */
  year: string;
  color: string;
  license_plate: string;
  license_plate_state: string;
  /** Parking decal number ("Permit number" on the Vehicles tab). */
  permit_number: string;
  notes: string;
}

/** resman_lease_employment — PK `resman_employment_id`. Port of LeaseEmployment.swift. */
export interface ResmanLeaseEmploymentRow {
  resman_employment_id: string;
  resman_person_lease_id: string;
  employer_name: string;
  position: string;
  phone: string;
  other_income_source: string;
  monthly_income: number | null;
  other_income: number | null;
  start_date: string | null;
}

/** resman_lease_insurance — PK `resman_insurance_id`. Port of LeaseInsurance.swift. */
export interface ResmanLeaseInsuranceRow {
  resman_insurance_id: string;
  resman_person_lease_id: string;
  provider: string;
  policy_number: string;
  policy_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  coverage_amount: number | null;
}

/** resman_lease_addresses — PK `resman_address_id`. Port of LeaseAddress.swift. */
export interface ResmanLeaseAddressRow {
  resman_address_id: string;
  resman_person_lease_id: string;
  address_type: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  start_date: string | null;
  end_date: string | null;
}

/** resman_lease_alternate_contacts — PK `resman_contact_id`. Port of LeaseAlternateContact.swift. */
export interface ResmanLeaseAlternateContactRow {
  resman_contact_id: string;
  resman_person_lease_id: string;
  name: string;
  relationship: string;
  phone: string;
  email: string;
  is_emergency_contact: boolean;
}

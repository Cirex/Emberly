import type { Database } from "@/types/database";
import type { AccessTokenSubject } from "@/lib/access-tokens";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * People directory + tenant profile for the manager app — a READ-ONLY path
 * over resman_residents and its five sub-tables (vehicles, insurance,
 * employment, alternate contacts, addresses), all of which are already synced
 * and until now surfaced on exactly one admin web page.
 *
 * Two shapes, deliberately different:
 *
 *   - The INDEX (`listPeopleIndex`) is the on-device search cache: one small
 *     row per resident with the four things search matches on — name, unit,
 *     phone, plate. It carries NO PII (no birthdate, no licence, no income),
 *     because it is persisted to the phone's disk.
 *   - The PROFILE (`getPersonProfile`) is the sheet: one resident with their
 *     lease facts, household, vehicles, insurance, employment, contacts,
 *     addresses and recent tickets. Birthdate, driver's licence and income are
 *     withheld unless the caller explicitly asks (`?includePii=1`), and every
 *     such ask is written to admin_audit_logs.
 *
 * The decision-useful number — rent-to-income — is ALWAYS returned, derived
 * server-side, so a manager can judge affordability without anyone's salary
 * crossing the wire.
 */

type ResidentRow = Database["public"]["Tables"]["resman_residents"]["Row"];
type VehicleRow = Database["public"]["Tables"]["resman_lease_vehicles"]["Row"];
type InsuranceRow = Database["public"]["Tables"]["resman_lease_insurance"]["Row"];
type EmploymentRow = Database["public"]["Tables"]["resman_lease_employment"]["Row"];
type ContactRow = Database["public"]["Tables"]["resman_lease_alternate_contacts"]["Row"];
type AddressRow = Database["public"]["Tables"]["resman_lease_addresses"]["Row"];
type LeaseRow = Database["public"]["Tables"]["resman_leases"]["Row"];
type UnitRow = Database["public"]["Tables"]["resman_units"]["Row"];
type WorkOrderRow = Database["public"]["Tables"]["resman_work_orders"]["Row"];

/** Recent tickets shown on a profile. The mockup shows two; ten is the cap. */
export const PROFILE_WORK_ORDER_LIMIT = 10;

/** PostgREST page size for the full-table index reads. */
export const INDEX_PAGE_SIZE = 1000;

/** Hard stop on paging, so a runaway table can never spin the request. */
const MAX_INDEX_PAGES = 25;

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

/**
 * Index columns. Note what is ABSENT: birthdate, drivers_license,
 * drivers_license_state. The directory index is cached on device; PII must not
 * ride along with it.
 */
export const PEOPLE_INDEX_RESIDENT_COLUMNS =
  "resman_person_lease_id, resman_person_id, resman_lease_id, first_name, last_name, " +
  "email, phone_numbers, household_status, is_primary";

export const PEOPLE_INDEX_LEASE_COLUMNS = "resman_lease_id, unit_number";

export const PEOPLE_INDEX_VEHICLE_COLUMNS =
  "resman_person_lease_id, license_plate, license_plate_state";

export const PROFILE_RESIDENT_COLUMNS =
  "resman_person_lease_id, resman_person_id, resman_lease_id, first_name, last_name, email, " +
  "phone_numbers, gender, birthdate, household_status, drivers_license, drivers_license_state, " +
  "language, identification, is_primary";

export const PROFILE_LEASE_COLUMNS =
  "resman_lease_id, resman_unit_id, unit_number, status, start_date, end_date, move_in_date, " +
  "move_out_date, leasing_agent, resident_rent, market_rent, balance";

export const PROFILE_UNIT_COLUMNS =
  "resman_unit_id, number, classification, bedrooms, times_late, occupancy_status";

export const PROFILE_VEHICLE_COLUMNS =
  "resman_vehicle_id, resman_person_lease_id, make, model, year, color, license_plate, " +
  "license_plate_state, parking_spot";

export const PROFILE_INSURANCE_COLUMNS =
  "resman_insurance_id, provider, policy_number, policy_type, status, start_date, end_date, " +
  "coverage_amount";

export const PROFILE_EMPLOYMENT_COLUMNS =
  "resman_employment_id, employer_name, position, phone, other_income_source, monthly_income, " +
  "other_income, start_date";

export const PROFILE_CONTACT_COLUMNS =
  "resman_contact_id, name, relationship, phone, email, is_emergency_contact";

export const PROFILE_ADDRESS_COLUMNS =
  "resman_address_id, address_type, street, city, state, postal_code, country, start_date, end_date";

export const PROFILE_WORK_ORDER_COLUMNS =
  "resman_work_order_id, number, title, status, priority, category, technician, date_reported, " +
  "date_completed, callback_status";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** A plate as the directory index carries it — enough for offline plate search. */
export interface PeopleIndexVehicle {
  plate: string;
  state: string;
}

/** One searchable resident. Small on purpose: this is cached on the device. */
export interface PeopleIndexEntry {
  personLeaseId: string;
  personId: string;
  leaseId: string;
  unitNumber: string;
  firstName: string;
  lastName: string;
  isPrimary: boolean;
  householdStatus: string;
  phones: string[];
  email: string;
  vehicles: PeopleIndexVehicle[];
}

/** The resident block of a profile. PII keys are present only under includePii. */
export interface PersonProfileResident {
  personLeaseId: string;
  personId: string;
  leaseId: string;
  firstName: string;
  lastName: string;
  email: string;
  phones: string[];
  gender: string;
  householdStatus: string;
  language: string;
  identification: string;
  isPrimary: boolean;
  /** PII — present only when the request passed `?includePii=1`. */
  birthdate?: string | null;
  /** PII — present only when the request passed `?includePii=1`. */
  driversLicense?: string;
  /** PII — present only when the request passed `?includePii=1`. */
  driversLicenseState?: string;
}

export interface PersonProfileLease {
  leaseId: string;
  unitId: string | null;
  unitNumber: string;
  status: string;
  classification: string;
  bedrooms: number | null;
  moveInDate: string | null;
  moveOutDate: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  residentRent: number | null;
  marketRent: number | null;
  balance: number | null;
  timesLate: number | null;
  leasingAgent: string;
}

export interface PersonProfileHouseholdMember {
  personLeaseId: string;
  firstName: string;
  lastName: string;
  isPrimary: boolean;
  householdStatus: string;
  phones: string[];
  email: string;
}

export interface PersonProfileVehicle {
  id: string;
  make: string;
  model: string;
  year: string;
  color: string;
  plate: string;
  state: string;
  parkingSpot: string;
}

export interface PersonProfileInsurance {
  id: string;
  provider: string;
  policyNumber: string;
  policyType: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  coverageAmount: number | null;
}

export interface PersonProfileEmployment {
  id: string;
  employerName: string;
  position: string;
  phone: string;
  otherIncomeSource: string;
  startDate: string | null;
  /** PII — present only when the request passed `?includePii=1`. */
  monthlyIncome?: number | null;
  /** PII — present only when the request passed `?includePii=1`. */
  otherIncome?: number | null;
}

export interface PersonProfileContact {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  email: string;
  isEmergencyContact: boolean;
}

export interface PersonProfileAddress {
  id: string;
  addressType: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  startDate: string | null;
  endDate: string | null;
}

export interface PersonProfileWorkOrder {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  category: string;
  technician: string;
  dateReported: string | null;
  dateCompleted: string | null;
  callbackStatus: string;
}

export interface PersonProfilePayload {
  resident: PersonProfileResident;
  lease: PersonProfileLease | null;
  household: PersonProfileHouseholdMember[];
  vehicles: PersonProfileVehicle[];
  insurance: PersonProfileInsurance[];
  employment: PersonProfileEmployment[];
  alternateContacts: PersonProfileContact[];
  addresses: PersonProfileAddress[];
  workOrders: PersonProfileWorkOrder[];
  /**
   * residentRent ÷ total monthly income, rounded to 4 decimals. Always
   * present (never gated) — it is the number that informs a decision, and it
   * discloses no salary. `null` when either side is missing or zero.
   */
  rentToIncomeRatio: number | null;
  /** Whether the PII fields were included in this response. */
  piiIncluded: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `?includePii=1` (or `true`) — anything else is a no. */
export function wantsPii(params: URLSearchParams): boolean {
  const raw = params.get("includePii")?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true";
}

/** Group plates by person-lease for the index. Blank plates are dropped. */
export function vehiclesByPerson(
  rows: Pick<VehicleRow, "resman_person_lease_id" | "license_plate" | "license_plate_state">[],
): Map<string, PeopleIndexVehicle[]> {
  const map = new Map<string, PeopleIndexVehicle[]>();
  for (const row of rows) {
    const plate = (row.license_plate ?? "").trim();
    if (plate === "") continue;
    const list = map.get(row.resman_person_lease_id) ?? [];
    list.push({ plate, state: (row.license_plate_state ?? "").trim() });
    map.set(row.resman_person_lease_id, list);
  }
  return map;
}

export type PeopleIndexResidentRow = Pick<
  ResidentRow,
  | "resman_person_lease_id"
  | "resman_person_id"
  | "resman_lease_id"
  | "first_name"
  | "last_name"
  | "email"
  | "phone_numbers"
  | "household_status"
  | "is_primary"
>;

/** One resident → one index row. */
export function peopleIndexEntry(
  row: PeopleIndexResidentRow,
  unitNumber: string,
  vehicles: PeopleIndexVehicle[],
): PeopleIndexEntry {
  return {
    personLeaseId: row.resman_person_lease_id,
    personId: row.resman_person_id ?? "",
    leaseId: row.resman_lease_id,
    unitNumber,
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    isPrimary: Boolean(row.is_primary),
    householdStatus: row.household_status ?? "",
    phones: (row.phone_numbers ?? []).filter((p) => p.trim() !== ""),
    email: row.email ?? "",
    vehicles,
  };
}

/** Alphabetical by last then first name — the directory's resting order. */
export function comparePeopleIndexEntries(a: PeopleIndexEntry, b: PeopleIndexEntry): number {
  const last = a.lastName.localeCompare(b.lastName);
  if (last !== 0) return last;
  const first = a.firstName.localeCompare(b.firstName);
  if (first !== 0) return first;
  return a.personLeaseId.localeCompare(b.personLeaseId);
}

/** Total monthly income across a person's employment rows (0 when unknown). */
export function totalMonthlyIncome(
  rows: Pick<EmploymentRow, "monthly_income" | "other_income">[],
): number {
  return rows.reduce((sum, row) => sum + (row.monthly_income ?? 0) + (row.other_income ?? 0), 0);
}

/**
 * Rent as a share of monthly income, 4-decimal rounded. `null` whenever the
 * ratio would be meaningless (no rent, no income) — never NaN or Infinity, so
 * the client can render "—" rather than guard arithmetic.
 */
export function rentToIncomeRatio(
  residentRent: number | null | undefined,
  monthlyIncome: number,
): number | null {
  if (!residentRent || residentRent <= 0) return null;
  if (!monthlyIncome || monthlyIncome <= 0) return null;
  return Math.round((residentRent / monthlyIncome) * 10_000) / 10_000;
}

/** Resident → wire shape. PII keys are OMITTED entirely unless `includePii`. */
export function personProfileResident(row: ResidentRow, includePii: boolean): PersonProfileResident {
  const base: PersonProfileResident = {
    personLeaseId: row.resman_person_lease_id,
    personId: row.resman_person_id ?? "",
    leaseId: row.resman_lease_id,
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    email: row.email ?? "",
    phones: (row.phone_numbers ?? []).filter((p) => p.trim() !== ""),
    gender: row.gender ?? "",
    householdStatus: row.household_status ?? "",
    language: row.language ?? "",
    identification: row.identification ?? "",
    isPrimary: Boolean(row.is_primary),
  };
  if (!includePii) return base;
  return {
    ...base,
    birthdate: row.birthdate ?? null,
    driversLicense: row.drivers_license ?? "",
    driversLicenseState: row.drivers_license_state ?? "",
  };
}

export function personProfileEmployment(
  row: Pick<
    EmploymentRow,
    | "resman_employment_id"
    | "employer_name"
    | "position"
    | "phone"
    | "other_income_source"
    | "monthly_income"
    | "other_income"
    | "start_date"
  >,
  includePii: boolean,
): PersonProfileEmployment {
  const base: PersonProfileEmployment = {
    id: row.resman_employment_id,
    employerName: row.employer_name ?? "",
    position: row.position ?? "",
    phone: row.phone ?? "",
    otherIncomeSource: row.other_income_source ?? "",
    startDate: row.start_date,
  };
  if (!includePii) return base;
  return { ...base, monthlyIncome: row.monthly_income, otherIncome: row.other_income };
}

export function personProfileVehicle(
  row: Pick<
    VehicleRow,
    | "resman_vehicle_id"
    | "make"
    | "model"
    | "year"
    | "color"
    | "license_plate"
    | "license_plate_state"
    | "parking_spot"
  >,
): PersonProfileVehicle {
  return {
    id: row.resman_vehicle_id,
    make: row.make ?? "",
    model: row.model ?? "",
    year: row.year ?? "",
    color: row.color ?? "",
    plate: (row.license_plate ?? "").trim(),
    state: (row.license_plate_state ?? "").trim(),
    parkingSpot: (row.parking_spot ?? "").trim(),
  };
}

export function personProfileInsurance(
  row: Pick<
    InsuranceRow,
    | "resman_insurance_id"
    | "provider"
    | "policy_number"
    | "policy_type"
    | "status"
    | "start_date"
    | "end_date"
    | "coverage_amount"
  >,
): PersonProfileInsurance {
  return {
    id: row.resman_insurance_id,
    provider: row.provider ?? "",
    policyNumber: row.policy_number ?? "",
    policyType: row.policy_type ?? "",
    status: row.status ?? "",
    startDate: row.start_date,
    endDate: row.end_date,
    coverageAmount: row.coverage_amount,
  };
}

export function personProfileContact(
  row: Pick<
    ContactRow,
    "resman_contact_id" | "name" | "relationship" | "phone" | "email" | "is_emergency_contact"
  >,
): PersonProfileContact {
  return {
    id: row.resman_contact_id,
    name: row.name ?? "",
    relationship: row.relationship ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    isEmergencyContact: Boolean(row.is_emergency_contact),
  };
}

export function personProfileAddress(
  row: Pick<
    AddressRow,
    | "resman_address_id"
    | "address_type"
    | "street"
    | "city"
    | "state"
    | "postal_code"
    | "country"
    | "start_date"
    | "end_date"
  >,
): PersonProfileAddress {
  return {
    id: row.resman_address_id,
    addressType: row.address_type ?? "",
    street: row.street ?? "",
    city: row.city ?? "",
    state: row.state ?? "",
    postalCode: row.postal_code ?? "",
    country: row.country ?? "",
    startDate: row.start_date,
    endDate: row.end_date,
  };
}

export function personProfileWorkOrder(
  row: Pick<
    WorkOrderRow,
    | "resman_work_order_id"
    | "number"
    | "title"
    | "status"
    | "priority"
    | "category"
    | "technician"
    | "date_reported"
    | "date_completed"
    | "callback_status"
  >,
): PersonProfileWorkOrder {
  return {
    id: row.resman_work_order_id,
    number: row.number ?? "",
    title: row.title ?? "",
    status: row.status ?? "",
    priority: row.priority ?? "",
    category: row.category ?? "",
    technician: row.technician ?? "",
    dateReported: row.date_reported,
    dateCompleted: row.date_completed,
    callbackStatus: row.callback_status ?? "none",
  };
}

// ---------------------------------------------------------------------------
// PII audit
// ---------------------------------------------------------------------------

/**
 * The audit action written when a manager reveals a masked field. Deliberately
 * NOT added to lib/admin-audit.ts's `AdminAuditAction` union — that file is a
 * shared type this feature does not own, and `admin_audit_logs.action` is free
 * text with no CHECK constraint, so the row lands correctly either way. A
 * follow-up should widen the union and add a label in
 * `formatAdminAuditAction` so the admin log page prints a friendly name.
 */
export const PEOPLE_PII_AUDIT_ACTION = "resident.pii_reveal";

/** Who asked. Mirrors `delinquencyActionActor` in lib/delinquency-actions.ts. */
export interface PeopleAuditActor {
  adminUserId: string;
  adminRole: string;
  adminDisplayName: string;
}

export function peopleAuditActor(
  auth: { kind: "token"; subject: AccessTokenSubject } | { kind: "scanner" },
): PeopleAuditActor {
  if (auth.kind === "token") {
    return {
      adminUserId: auth.subject.subjectId,
      adminRole: auth.subject.role,
      adminDisplayName: auth.subject.label,
    };
  }
  return { adminUserId: "scanner", adminRole: "scanner", adminDisplayName: "scanner" };
}

export interface PeoplePiiAuditInput {
  personLeaseId: string;
  /** Which masked field the reveal was for, when the client says so. */
  field?: string;
  leaseId?: string;
  unitNumber?: string;
}

/** The admin_audit_logs row for one PII reveal: who, for whom, and when. */
export function buildPeoplePiiAuditLog(
  actor: PeopleAuditActor,
  input: PeoplePiiAuditInput,
  createdAt: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    admin_user_id: actor.adminUserId,
    admin_role: actor.adminRole,
    admin_display_name: actor.adminDisplayName,
    action: PEOPLE_PII_AUDIT_ACTION,
    target_type: "resident",
    target_id: input.personLeaseId,
    metadata: {
      field: input.field ?? "all",
      lease_id: input.leaseId ?? "",
      unit_number: input.unitNumber ?? "",
      surface: "manager_app",
    },
    created_at: createdAt,
  };
}

/**
 * Write the reveal to the audit log. NEVER throws: a logging failure must not
 * deny a manager the record they are entitled to see — it is reported instead,
 * exactly like `recordAdminAuditLog`.
 */
export async function recordPeoplePiiAccess(
  client: UntypedSupabase,
  actor: PeopleAuditActor,
  input: PeoplePiiAuditInput,
): Promise<void> {
  try {
    const { error } = await client
      .from("admin_audit_logs")
      .insert(buildPeoplePiiAuditLog(actor, input));
    if (error) console.error("[manager-people] PII audit log failed:", error.message);
  } catch (error) {
    console.error("[manager-people] PII audit log threw:", error);
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Read a whole table in PostgREST pages. The directory index spans every
 * resident and every vehicle on the property — both are comfortably over the
 * 1000-row default cap, so a single unranged select would silently truncate
 * the search index.
 */
async function selectAllPaged<T>(
  client: UntypedSupabase,
  table: string,
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_INDEX_PAGES; page++) {
    const from = page * INDEX_PAGE_SIZE;
    const { data, error } = await client
      .from(table)
      .select(columns)
      .range(from, from + INDEX_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < INDEX_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * The whole directory as one lightweight, PII-free array — every resident with
 * their unit, phones, email and plates, alphabetical by surname.
 */
export async function listPeopleIndex(client: UntypedSupabase): Promise<PeopleIndexEntry[]> {
  const residents = await selectAllPaged<PeopleIndexResidentRow>(
    client,
    "resman_residents",
    PEOPLE_INDEX_RESIDENT_COLUMNS,
  );
  const leases = await selectAllPaged<Pick<LeaseRow, "resman_lease_id" | "unit_number">>(
    client,
    "resman_leases",
    PEOPLE_INDEX_LEASE_COLUMNS,
  );
  const vehicles = await selectAllPaged<
    Pick<VehicleRow, "resman_person_lease_id" | "license_plate" | "license_plate_state">
  >(client, "resman_lease_vehicles", PEOPLE_INDEX_VEHICLE_COLUMNS);

  const unitByLease = new Map(leases.map((l) => [l.resman_lease_id, l.unit_number ?? ""]));
  const plates = vehiclesByPerson(vehicles);

  return residents
    .map((row) =>
      peopleIndexEntry(
        row,
        unitByLease.get(row.resman_lease_id) ?? "",
        plates.get(row.resman_person_lease_id) ?? [],
      ),
    )
    .sort(comparePeopleIndexEntries);
}

async function fetchOne<T>(
  client: UntypedSupabase,
  table: string,
  columns: string,
  column: string,
  value: string,
): Promise<T | null> {
  const { data, error } = await client
    .from(table)
    .select(columns)
    .eq(column, value)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as T | null;
}

async function fetchMany<T>(
  client: UntypedSupabase,
  table: string,
  columns: string,
  column: string,
  value: string,
): Promise<T[]> {
  const { data, error } = await client.from(table).select(columns).eq(column, value);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

/**
 * The full profile behind one personLeaseId, or `null` when the id is unknown
 * (the route answers 404). `includePii` decides whether birthdate, licence and
 * income are in the payload; the derived rent-to-income ratio is computed
 * regardless and always returned.
 */
export async function getPersonProfile(
  client: UntypedSupabase,
  personLeaseId: string,
  includePii = false,
): Promise<PersonProfilePayload | null> {
  const resident = await fetchOne<ResidentRow>(
    client,
    "resman_residents",
    PROFILE_RESIDENT_COLUMNS,
    "resman_person_lease_id",
    personLeaseId,
  );
  if (!resident) return null;

  const lease = resident.resman_lease_id
    ? await fetchOne<
        Pick<
          LeaseRow,
          | "resman_lease_id"
          | "resman_unit_id"
          | "unit_number"
          | "status"
          | "start_date"
          | "end_date"
          | "move_in_date"
          | "move_out_date"
          | "leasing_agent"
          | "resident_rent"
          | "market_rent"
          | "balance"
        >
      >(client, "resman_leases", PROFILE_LEASE_COLUMNS, "resman_lease_id", resident.resman_lease_id)
    : null;

  // classification / times_late live on the unit mirror, not the lease.
  const unit = lease?.resman_unit_id
    ? await fetchOne<
        Pick<UnitRow, "resman_unit_id" | "number" | "classification" | "bedrooms" | "times_late">
      >(client, "resman_units", PROFILE_UNIT_COLUMNS, "resman_unit_id", lease.resman_unit_id)
    : null;

  const [householdRows, vehicleRows, insuranceRows, employmentRows, contactRows, addressRows] =
    await Promise.all([
      lease
        ? fetchMany<
            Pick<
              ResidentRow,
              | "resman_person_lease_id"
              | "first_name"
              | "last_name"
              | "is_primary"
              | "household_status"
              | "phone_numbers"
              | "email"
            >
          >(
            client,
            "resman_residents",
            "resman_person_lease_id, first_name, last_name, is_primary, household_status, phone_numbers, email",
            "resman_lease_id",
            lease.resman_lease_id,
          )
        : Promise.resolve([]),
      fetchMany<VehicleRow>(
        client,
        "resman_lease_vehicles",
        PROFILE_VEHICLE_COLUMNS,
        "resman_person_lease_id",
        personLeaseId,
      ),
      fetchMany<InsuranceRow>(
        client,
        "resman_lease_insurance",
        PROFILE_INSURANCE_COLUMNS,
        "resman_person_lease_id",
        personLeaseId,
      ),
      fetchMany<EmploymentRow>(
        client,
        "resman_lease_employment",
        PROFILE_EMPLOYMENT_COLUMNS,
        "resman_person_lease_id",
        personLeaseId,
      ),
      fetchMany<ContactRow>(
        client,
        "resman_lease_alternate_contacts",
        PROFILE_CONTACT_COLUMNS,
        "resman_person_lease_id",
        personLeaseId,
      ),
      fetchMany<AddressRow>(
        client,
        "resman_lease_addresses",
        PROFILE_ADDRESS_COLUMNS,
        "resman_person_lease_id",
        personLeaseId,
      ),
    ]);

  const unitNumber = lease?.unit_number ?? unit?.number ?? "";
  const workOrders = unitNumber ? await listUnitWorkOrders(client, unitNumber) : [];

  return {
    resident: personProfileResident(resident, includePii),
    lease: lease
      ? {
          leaseId: lease.resman_lease_id,
          unitId: lease.resman_unit_id,
          unitNumber,
          status: lease.status ?? "",
          classification: unit?.classification ?? "",
          bedrooms: unit?.bedrooms ?? null,
          moveInDate: lease.move_in_date,
          moveOutDate: lease.move_out_date,
          leaseStart: lease.start_date,
          leaseEnd: lease.end_date,
          residentRent: lease.resident_rent,
          marketRent: lease.market_rent,
          balance: lease.balance,
          timesLate: unit?.times_late ?? null,
          leasingAgent: lease.leasing_agent ?? "",
        }
      : null,
    household: householdRows
      .filter((row) => row.resman_person_lease_id !== personLeaseId)
      .map((row) => ({
        personLeaseId: row.resman_person_lease_id,
        firstName: row.first_name ?? "",
        lastName: row.last_name ?? "",
        isPrimary: Boolean(row.is_primary),
        householdStatus: row.household_status ?? "",
        phones: (row.phone_numbers ?? []).filter((p) => p.trim() !== ""),
        email: row.email ?? "",
      })),
    vehicles: vehicleRows.map(personProfileVehicle),
    insurance: insuranceRows.map(personProfileInsurance),
    employment: employmentRows.map((row) => personProfileEmployment(row, includePii)),
    alternateContacts: contactRows.map(personProfileContact),
    addresses: addressRows.map(personProfileAddress),
    workOrders,
    rentToIncomeRatio: rentToIncomeRatio(
      lease?.resident_rent ?? null,
      totalMonthlyIncome(employmentRows),
    ),
    piiIncluded: includePii,
  };
}

/** The unit's recent tickets, newest reported first, capped for the sheet. */
export async function listUnitWorkOrders(
  client: UntypedSupabase,
  unitNumber: string,
): Promise<PersonProfileWorkOrder[]> {
  const { data, error } = await client
    .from("resman_work_orders")
    .select(PROFILE_WORK_ORDER_COLUMNS)
    .eq("unit_number", unitNumber)
    .order("date_reported", { ascending: false })
    .limit(PROFILE_WORK_ORDER_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as WorkOrderRow[]).map(personProfileWorkOrder);
}

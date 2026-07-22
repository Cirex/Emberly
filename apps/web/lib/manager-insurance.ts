import type { AccessTokenSubject } from "@/lib/access-tokens";
import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Insurance-compliance board for the manager app — two halves, exactly the
 * delinquency split:
 *
 *   - POLICIES are a READ path over data already synced: one row per CURRENT
 *     lease joining its best resman_lease_insurance row (latest end_date via
 *     the lease's residents). ResMan stays the source of the policy record.
 *     Leases with no policy row at all keep their policy fields null — the
 *     board's deliberately separate NEVER FILED band ("'Never filed' is
 *     honest": conflating it with lapsed would produce a scary number nobody
 *     trusts). Compliance itself is a date comparison done on device — no
 *     status inference happens here.
 *   - ACTIONS are the Emberly-owned follow-up trail (proof requests, second
 *     notices, manual verifications, notes) keyed to the lease, exactly like
 *     delinquency_actions. "Lapse detected" is NOT a stored row — the phone
 *     derives it from the policy end date.
 *
 * MASKING: the full policy number never crosses the wire. Only the last four
 * characters leave the server (`policyNumberLast4`) — the board and the
 * detail sheet both render "···1234", and there is no reveal path.
 */

export type InsuranceActionRow = Database["public"]["Tables"]["insurance_actions"]["Row"];
export type InsuranceActionKind = InsuranceActionRow["kind"];

export const INSURANCE_ACTION_KINDS = [
  "proof_requested",
  "second_notice",
  "verified",
  "note",
] as const satisfies readonly InsuranceActionKind[];

type LeaseRow = Database["public"]["Tables"]["resman_leases"]["Row"];
type ResidentRow = Database["public"]["Tables"]["resman_residents"]["Row"];
type InsuranceRow = Database["public"]["Tables"]["resman_lease_insurance"]["Row"];
type UnitRow = Database["public"]["Tables"]["resman_units"]["Row"];

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

export const INSURANCE_LEASE_COLUMNS =
  "resman_lease_id, resman_unit_id, unit_number, start_date, move_in_date";

export const INSURANCE_RESIDENT_COLUMNS = "resman_person_lease_id, resman_lease_id";

export const INSURANCE_POLICY_COLUMNS =
  "resman_insurance_id, resman_person_lease_id, provider, policy_number, policy_type, " +
  "start_date, end_date, coverage_amount";

export const INSURANCE_UNIT_COLUMNS = "resman_unit_id, number, tenant_names";

/** The insurance_actions columns the mobile payload carries. */
export const INSURANCE_ACTION_COLUMNS =
  "id, resman_lease_id, unit_number, kind, note, created_by, created_at";

export type InsuranceLeaseRow = Pick<
  LeaseRow,
  "resman_lease_id" | "resman_unit_id" | "unit_number" | "start_date" | "move_in_date"
>;
export type InsuranceResidentRow = Pick<
  ResidentRow,
  "resman_person_lease_id" | "resman_lease_id"
>;
export type InsurancePolicyRow = Pick<
  InsuranceRow,
  | "resman_insurance_id"
  | "resman_person_lease_id"
  | "provider"
  | "policy_number"
  | "policy_type"
  | "start_date"
  | "end_date"
  | "coverage_amount"
>;
export type InsuranceUnitRow = Pick<UnitRow, "resman_unit_id" | "number" | "tenant_names">;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * One CURRENT lease with its best policy. Policy fields are all-null when the
 * lease has no resman_lease_insurance row at all — the NEVER FILED band.
 */
export interface InsurancePolicyPayload {
  leaseId: string;
  unitNumber: string;
  /** From the resman_units mirror's tenant_names, [] when the unit is unknown. */
  tenantNames: string[];
  /** move_in_date ?? start_date — "no policy on file since move-in <date>". */
  leaseStart: string | null;
  /** The resman insurance row id; null = never filed. */
  policyId: string | null;
  provider: string | null;
  /** Last four characters only — the full number never leaves the server. */
  policyNumberLast4: string | null;
  policyType: string | null;
  coverageAmount: number | null;
  startDate: string | null;
  endDate: string | null;
}

/** One follow-up action, camelCased for the wire. */
export interface InsuranceActionPayload {
  id: string;
  resmanLeaseId: string;
  unitNumber: string;
  kind: InsuranceActionKind;
  note: string;
  createdBy: string;
  createdAt: string | null;
}

export type InsuranceActionSelect = Pick<
  InsuranceActionRow,
  "id" | "resman_lease_id" | "unit_number" | "kind" | "note" | "created_by" | "created_at"
>;

export function insuranceActionPayload(row: InsuranceActionSelect): InsuranceActionPayload {
  return {
    id: row.id,
    resmanLeaseId: row.resman_lease_id,
    unitNumber: row.unit_number,
    kind: row.kind,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Server-side policy-number masking: the trimmed number's last four
 * characters, "" when the row carries no number at all. The full number is
 * never part of any payload.
 */
export function maskPolicyNumber(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.slice(-4);
}

/**
 * The lease's BEST policy: the row with the latest end_date. Dated rows beat
 * undated rows; among undated rows the first wins (stable). Null when the
 * lease has no policy rows — the NEVER FILED case.
 */
export function bestPolicy(rows: readonly InsurancePolicyRow[]): InsurancePolicyRow | null {
  let best: InsurancePolicyRow | null = null;
  for (const row of rows) {
    if (best === null) {
      best = row;
      continue;
    }
    const bestEnd = best.end_date ?? "";
    const rowEnd = row.end_date ?? "";
    if (rowEnd > bestEnd) best = row;
  }
  return best;
}

/** Assemble one lease's board row from its (possibly absent) best policy. */
export function insurancePolicyPayload(
  lease: InsuranceLeaseRow,
  policy: InsurancePolicyRow | null,
  tenantNames: string[],
): InsurancePolicyPayload {
  return {
    leaseId: lease.resman_lease_id,
    unitNumber: lease.unit_number,
    tenantNames,
    leaseStart: lease.move_in_date ?? lease.start_date,
    policyId: policy?.resman_insurance_id ?? null,
    provider: policy ? policy.provider : null,
    policyNumberLast4: policy ? maskPolicyNumber(policy.policy_number) : null,
    policyType: policy ? policy.policy_type : null,
    coverageAmount: policy ? policy.coverage_amount : null,
    startDate: policy ? policy.start_date : null,
    endDate: policy ? policy.end_date : null,
  };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export interface InsuranceActionActor {
  createdBy: string;
  createdByAdminId: string;
}

/**
 * Attribution from a `requireResmanApiKey` success — mirrors
 * delinquencyActionActor: token callers record the token's label plus the
 * admin id when the subject is an admin user. Scanner callers never reach the
 * manager surface (the routes 403 them), but the shape stays total for
 * safety.
 */
export function insuranceActionActor(
  auth: { kind: "token"; subject: AccessTokenSubject } | { kind: "scanner" },
): InsuranceActionActor {
  if (auth.kind === "token") {
    return {
      createdBy: auth.subject.label,
      createdByAdminId: auth.subject.subjectType === "admin_user" ? auth.subject.subjectId : "",
    };
  }
  return { createdBy: "scanner", createdByAdminId: "" };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** PostgREST page size for the full-table reads (same as manager-people). */
export const INSURANCE_PAGE_SIZE = 1000;

/** Hard stop on paging, so a runaway table can never spin the request. */
const MAX_PAGES = 25;

/**
 * Read a filtered table in PostgREST pages. Current leases, residents,
 * insurance rows and units can each exceed the 1000-row default cap on a
 * property this size — an unranged select would silently truncate the board.
 */
async function selectAllPaged<T>(
  client: UntypedSupabase,
  table: string,
  columns: string,
  filter?: { column: string; value: boolean },
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * INSURANCE_PAGE_SIZE;
    let query = client.from(table).select(columns);
    if (filter) query = query.eq(filter.column, filter.value);
    const { data, error } = await query.range(from, from + INSURANCE_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < INSURANCE_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * One board row per CURRENT lease (is_current_lease), joining the lease's
 * best insurance policy (latest end_date across its residents' rows) and the
 * unit mirror's tenant names. Sorted by unit number for a stable wire order —
 * the phone re-bands and re-sorts on device.
 */
export async function listInsurancePolicies(
  client: UntypedSupabase,
): Promise<InsurancePolicyPayload[]> {
  const [leases, residents, policies, units] = await Promise.all([
    selectAllPaged<InsuranceLeaseRow>(client, "resman_leases", INSURANCE_LEASE_COLUMNS, {
      column: "is_current_lease",
      value: true,
    }),
    selectAllPaged<InsuranceResidentRow>(
      client,
      "resman_residents",
      INSURANCE_RESIDENT_COLUMNS,
    ),
    selectAllPaged<InsurancePolicyRow>(
      client,
      "resman_lease_insurance",
      INSURANCE_POLICY_COLUMNS,
    ),
    selectAllPaged<InsuranceUnitRow>(client, "resman_units", INSURANCE_UNIT_COLUMNS),
  ]);

  // person-lease → lease, then policy rows grouped per lease.
  const leaseByPerson = new Map(
    residents.map((r) => [r.resman_person_lease_id, r.resman_lease_id]),
  );
  const policiesByLease = new Map<string, InsurancePolicyRow[]>();
  for (const row of policies) {
    const leaseId = leaseByPerson.get(row.resman_person_lease_id);
    if (!leaseId) continue;
    const list = policiesByLease.get(leaseId);
    if (list) list.push(row);
    else policiesByLease.set(leaseId, [row]);
  }

  const unitById = new Map(units.map((u) => [u.resman_unit_id, u]));
  const unitByNumber = new Map(units.map((u) => [u.number, u]));
  const tenantNamesOf = (lease: InsuranceLeaseRow): string[] => {
    const unit =
      (lease.resman_unit_id ? unitById.get(lease.resman_unit_id) : undefined) ??
      (lease.unit_number ? unitByNumber.get(lease.unit_number) : undefined);
    return unit?.tenant_names ?? [];
  };

  return leases
    .map((lease) =>
      insurancePolicyPayload(
        lease,
        bestPolicy(policiesByLease.get(lease.resman_lease_id) ?? []),
        tenantNamesOf(lease),
      ),
    )
    .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber));
}

/** Every non-deleted follow-up action, newest first. */
export async function listInsuranceActions(
  client: UntypedSupabase,
): Promise<InsuranceActionPayload[]> {
  const { data, error } = await client
    .from("insurance_actions")
    .select(INSURANCE_ACTION_COLUMNS)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as InsuranceActionSelect[]).map(insuranceActionPayload);
}

export interface InsuranceActionInput {
  resmanLeaseId: string;
  unitNumber?: string;
  kind: InsuranceActionKind;
  note?: string;
}

/** Record one follow-up action; returns the stored row's payload. */
export async function createInsuranceAction(
  client: UntypedSupabase,
  input: InsuranceActionInput,
  actor: InsuranceActionActor,
): Promise<InsuranceActionPayload> {
  const { data, error } = await client
    .from("insurance_actions")
    .insert({
      resman_lease_id: input.resmanLeaseId,
      unit_number: input.unitNumber ?? "",
      kind: input.kind,
      note: input.note ?? "",
      created_by: actor.createdBy,
      created_by_admin_id: actor.createdByAdminId,
    })
    .select(INSURANCE_ACTION_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return insuranceActionPayload(data as InsuranceActionSelect);
}

/**
 * Soft delete: sets deleted_at. Returns false when the id is unknown or the
 * row is already deleted (the route answers 404).
 */
export async function softDeleteInsuranceAction(
  client: UntypedSupabase,
  id: string,
): Promise<boolean> {
  const { data } = await client
    .from("insurance_actions")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return false;

  const { error } = await client
    .from("insurance_actions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  return true;
}

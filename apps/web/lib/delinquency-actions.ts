import type { AccessTokenSubject } from "@/lib/access-tokens";
import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Collections timeline for the manager app. Property managers record
 * touchpoints (calls, notices served, promises to pay, FED filings,
 * write-offs, …) against a lease; the phone derives the delinquency board from
 * these plus the resman_units delinquency mirror. Emberly-only writes — ResMan
 * is never touched. The lease reference is soft: the sync's delete-missing
 * pass may remove a lease, but the action history must survive it, so rows are
 * soft deleted (deleted_at) and never cascade.
 */

export type DelinquencyActionRow = Database["public"]["Tables"]["delinquency_actions"]["Row"];
export type DelinquencyActionKind = DelinquencyActionRow["kind"];

export const DELINQUENCY_ACTION_KINDS = [
  "note",
  "called",
  "notice_served",
  "promise_recorded",
  "promise_kept",
  "promise_broken",
  "fed_filed",
  "eviction_completed",
  "writeoff",
  "payment_plan",
] as const satisfies readonly DelinquencyActionKind[];

/** The only kinds that carry a promise_due_date (mirrors the column comment). */
export const PROMISE_DATED_KINDS: ReadonlySet<DelinquencyActionKind> = new Set([
  "promise_recorded",
  "payment_plan",
]);

export interface DelinquencyActionActor {
  createdBy: string;
  createdByAdminId: string;
}

/**
 * Attribution from a `requireResmanApiKey` success, exactly like
 * workOrderPhotoActor: token callers record the token's label (the staff
 * display name for admin-minted app tokens) plus the admin id when the subject
 * is an admin user. Scanner callers never reach the manager surface (the
 * routes 403 them), but the shape stays total for safety.
 */
export function delinquencyActionActor(
  auth: { kind: "token"; subject: AccessTokenSubject } | { kind: "scanner" },
): DelinquencyActionActor {
  if (auth.kind === "token") {
    return {
      createdBy: auth.subject.label,
      createdByAdminId: auth.subject.subjectType === "admin_user" ? auth.subject.subjectId : "",
    };
  }
  return { createdBy: "scanner", createdByAdminId: "" };
}

/** The delinquency_actions columns the mobile payload carries. */
export const DELINQUENCY_ACTION_COLUMNS =
  "id, resman_lease_id, resman_unit_id, unit_number, kind, note, amount, promise_due_date, created_by, created_at";

/** The subset of the row the API selects (created_by_admin_id stays internal). */
export type DelinquencyActionSelect = Pick<
  DelinquencyActionRow,
  | "id"
  | "resman_lease_id"
  | "resman_unit_id"
  | "unit_number"
  | "kind"
  | "note"
  | "amount"
  | "promise_due_date"
  | "created_by"
  | "created_at"
>;

/** One action, camelCased for the wire. */
export interface DelinquencyActionPayload {
  id: string;
  resmanLeaseId: string;
  resmanUnitId: string;
  unitNumber: string;
  kind: DelinquencyActionKind;
  note: string;
  amount: number | null;
  promiseDueDate: string | null;
  createdBy: string;
  createdAt: string | null;
}

export function delinquencyActionPayload(row: DelinquencyActionSelect): DelinquencyActionPayload {
  return {
    id: row.id,
    resmanLeaseId: row.resman_lease_id,
    resmanUnitId: row.resman_unit_id,
    unitNumber: row.unit_number,
    kind: row.kind,
    note: row.note,
    amount: row.amount,
    promiseDueDate: row.promise_due_date,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * How many unit ids may ride in one `.in(...)` filter.
 *
 * PostgREST takes its filters in the query string, so an `.in()` list is spent
 * URL budget: a UUID plus its separator is ~37 characters, and the server
 * rejects a request line past ~8KB with a bare `414 Request URI Too Long`.
 *
 * This is not hypothetical. The board qualifies every unit that owes money or
 * carries a collections note — 234 of them on this property — which built a
 * 9,380-character URL, 414'd, and took the whole delinquency endpoint down
 * with a 500. The failure was load-dependent and silent: it worked until
 * delinquency grew past ~200 units, then the Money board simply went blank.
 *
 * 150 keeps the longest request near 5.5KB with generous headroom for the
 * select list and the other filters. `units/details` learned the same lesson
 * the other way, by reading whole tables instead of building `.in()` lists.
 */
export const ACTION_UNIT_ID_CHUNK = 150;

/** Non-deleted actions for the given units, newest first. */
export async function listDelinquencyActionsForUnits(
  client: UntypedSupabase,
  unitIds: readonly string[],
): Promise<DelinquencyActionPayload[]> {
  if (unitIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < unitIds.length; i += ACTION_UNIT_ID_CHUNK) {
    chunks.push(unitIds.slice(i, i + ACTION_UNIT_ID_CHUNK) as string[]);
  }

  const batches = await Promise.all(
    chunks.map(async (ids) => {
      const { data, error } = await client
        .from("delinquency_actions")
        .select(DELINQUENCY_ACTION_COLUMNS)
        .in("resman_unit_id", ids)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as DelinquencyActionSelect[];
    }),
  );

  // Each chunk is sorted; the concatenation is not. Re-sort so the caller
  // still gets one newest-first timeline across every unit.
  return batches
    .flat()
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map(delinquencyActionPayload);
}

export interface DelinquencyActionInput {
  resmanLeaseId: string;
  resmanUnitId?: string;
  unitNumber?: string;
  kind: DelinquencyActionKind;
  note?: string;
  amount?: number;
  promiseDueDate?: string;
}

/** Record one action; returns the stored row's payload. */
export async function createDelinquencyAction(
  client: UntypedSupabase,
  input: DelinquencyActionInput,
  actor: DelinquencyActionActor,
): Promise<DelinquencyActionPayload> {
  const { data, error } = await client
    .from("delinquency_actions")
    .insert({
      resman_lease_id: input.resmanLeaseId,
      resman_unit_id: input.resmanUnitId ?? "",
      unit_number: input.unitNumber ?? "",
      kind: input.kind,
      note: input.note ?? "",
      amount: input.amount ?? null,
      promise_due_date: input.promiseDueDate ?? null,
      created_by: actor.createdBy,
      created_by_admin_id: actor.createdByAdminId,
    })
    .select(DELINQUENCY_ACTION_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return delinquencyActionPayload(data as DelinquencyActionSelect);
}

/**
 * Soft delete: sets deleted_at. Returns false when the id is unknown or the
 * row is already deleted (the route answers 404).
 */
export async function softDeleteDelinquencyAction(
  client: UntypedSupabase,
  id: string,
): Promise<boolean> {
  const { data } = await client
    .from("delinquency_actions")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return false;

  const { error } = await client
    .from("delinquency_actions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  return true;
}

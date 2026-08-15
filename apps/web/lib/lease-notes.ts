import type { AccessTokenSubject } from "@/lib/access-tokens";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Shared staff notes thread on a lease — the manager app's pipeline detail
 * sheet. Any staff role posts free-text notes; every note carries the author's
 * display name and role so the thread reads like a conversation ("Eric Parker
 * · Leasing"). Emberly-only writes, the delinquency_actions pattern: ResMan is
 * never touched, the lease reference is soft, rows soft-delete.
 */

export const LEASE_NOTE_MAX_LENGTH = 4000;

export interface LeaseNoteActor {
  createdBy: string;
  createdByRole: string;
  createdByAdminId: string;
}

/** Attribution from a `requireStaffToken` success — label + role + admin id. */
export function leaseNoteActor(auth: { subject: AccessTokenSubject }): LeaseNoteActor {
  return {
    createdBy: auth.subject.label,
    createdByRole: auth.subject.role,
    createdByAdminId: auth.subject.subjectType === "admin_user" ? auth.subject.subjectId : "",
  };
}

const NOTE_COLUMNS = "id, resman_lease_id, unit_number, body, created_by, created_by_role, created_at";

interface LeaseNoteRow {
  id: string;
  resman_lease_id: string;
  unit_number: string;
  body: string;
  created_by: string;
  created_by_role: string;
  created_at: string | null;
}

/** One note, camelCased for the wire (created_by_admin_id stays internal). */
export interface LeaseNotePayload {
  id: string;
  resmanLeaseId: string;
  unitNumber: string;
  body: string;
  createdBy: string;
  createdByRole: string;
  createdAt: string | null;
}

function payload(row: LeaseNoteRow): LeaseNotePayload {
  return {
    id: row.id,
    resmanLeaseId: row.resman_lease_id,
    unitNumber: row.unit_number,
    body: row.body,
    createdBy: row.created_by,
    createdByRole: row.created_by_role,
    createdAt: row.created_at,
  };
}

/** Non-deleted notes for one lease, oldest first (a thread reads downward). */
export async function listLeaseNotes(
  client: UntypedSupabase,
  resmanLeaseId: string,
): Promise<LeaseNotePayload[]> {
  const { data, error } = await client
    .from("lease_notes")
    .select(NOTE_COLUMNS)
    .eq("resman_lease_id", resmanLeaseId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as LeaseNoteRow[]).map(payload);
}

export async function createLeaseNote(
  client: UntypedSupabase,
  input: { resmanLeaseId: string; unitNumber?: string; body: string },
  actor: LeaseNoteActor,
): Promise<LeaseNotePayload> {
  const { data, error } = await client
    .from("lease_notes")
    .insert({
      resman_lease_id: input.resmanLeaseId,
      unit_number: input.unitNumber ?? "",
      body: input.body,
      created_by: actor.createdBy,
      created_by_role: actor.createdByRole,
      created_by_admin_id: actor.createdByAdminId,
    })
    .select(NOTE_COLUMNS)
    .single();
  if (error) throw error;
  return payload(data as LeaseNoteRow);
}

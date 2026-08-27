import type { AccessTokenSubject } from "@/lib/access-tokens";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * The durable half of the work-order write path: the edit/close routes append
 * one row per requested change to `maintenance_work_order_edits`, and the sync
 * worker's flush job replays it against ResMan's edit form. ResMan is the
 * system of record — `resman_work_orders` is never written here, and the
 * maintenance app's optimistic overlays retire when the next sync pass shows
 * the mirror absorbed the change.
 *
 * Dedupe: ONE live queued row per (work order, kind). The app's offline queue
 * re-sends its full merged patch until acked, so a retry REPLACES the queued
 * row's patch rather than stacking a duplicate write; a unique partial index
 * backstops the race. Rows already claimed by the flusher (`applying`) are
 * left alone — a new request during a flush becomes a fresh queued row.
 */

export type WorkOrderWriteKind = "edit" | "close";

export interface WorkOrderEditPatch {
  technician?: string;
  description?: string;
  completionNotes?: string;
  scheduledAt?: string | null;
}

export interface WorkOrderClosePatch {
  note?: string;
  completedAt?: string;
}

export interface WorkOrderWriteActor {
  requestedBy: string;
  requestedByRole: string;
  requestedByAdminId: string;
}

/** Attribution from a `requireResmanApiKey` token success — label + role + admin id. */
export function workOrderWriteActor(auth: { subject: AccessTokenSubject }): WorkOrderWriteActor {
  return {
    requestedBy: auth.subject.label,
    requestedByRole: auth.subject.role,
    requestedByAdminId: auth.subject.subjectType === "admin_user" ? auth.subject.subjectId : "",
  };
}

const TABLE = "maintenance_work_order_edits";
/** Postgres unique_violation — the queued-row race lost; retry as an update. */
const UNIQUE_VIOLATION = "23505";

export interface QueueWorkOrderWriteResult {
  id: string;
  /** True when an existing queued row was replaced instead of a new insert. */
  replaced: boolean;
}

export async function queueWorkOrderWrite(
  client: UntypedSupabase,
  params: {
    workOrderId: string;
    kind: WorkOrderWriteKind;
    patch: WorkOrderEditPatch | WorkOrderClosePatch;
    actor: WorkOrderWriteActor;
  },
): Promise<QueueWorkOrderWriteResult> {
  const { workOrderId, kind, patch, actor } = params;

  const replaceQueued = async (): Promise<string | null> => {
    const { data, error } = await client
      .from(TABLE)
      .update({
        patch,
        requested_by: actor.requestedBy,
        requested_by_role: actor.requestedByRole,
        requested_by_admin_id: actor.requestedByAdminId,
        attempts: 0,
        last_error: "",
        updated_at: new Date().toISOString(),
      })
      .eq("resman_work_order_id", workOrderId)
      .eq("kind", kind)
      .eq("status", "queued")
      .select("id");
    if (error) throw new Error(`replace queued write failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string }>;
    return rows.length > 0 ? rows[0].id : null;
  };

  // Replace-first: the common retry path touches the existing queued row.
  const replacedId = await replaceQueued();
  if (replacedId) return { id: replacedId, replaced: true };

  const { data, error } = await client
    .from(TABLE)
    .insert({
      resman_work_order_id: workOrderId,
      kind,
      patch,
      requested_by: actor.requestedBy,
      requested_by_role: actor.requestedByRole,
      requested_by_admin_id: actor.requestedByAdminId,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Lost the race to a concurrent enqueue — its row is the live one; put
      // this (newer) patch on it.
      const raced = await replaceQueued();
      if (raced) return { id: raced, replaced: true };
    }
    throw new Error(`queue work-order write failed: ${error.message}`);
  }
  return { id: (data as { id: string }).id, replaced: false };
}

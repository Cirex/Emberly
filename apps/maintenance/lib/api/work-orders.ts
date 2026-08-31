import { z } from "zod";
// @emberly/core is framework-free, so the refusal class can load eagerly; the
// direct-writer and analytics modules reach expo/react-native natives and are
// imported LAZILY inside the write path — this module's schemas are consumed
// by pure derived-logic tests that must never touch the native stack.
import {
  WorkOrderWriteRefused,
  type WorkOrderWriteRequest,
  type WorkOrderWriteResult,
} from "@emberly/core";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * GET /api/resman/work-orders — the resman_work_orders mirror, read with the
 * signed-in staff member's Bearer token.
 *
 * Status/priority/callback_status are string-tolerant on purpose: the sync's
 * CHECK constraints define today's sets, but a widened enum upstream must
 * degrade to a fallback tint in the UI, never a red screen.
 */

const str = z.string().nullable().optional();

export const WorkOrderSchema = z.object({
  resman_work_order_id: z.string(),
  number: z.string().default(""),
  resman_unit_id: str,
  unit_lease_group_id: z.string().default(""),
  resman_lease_id: z.string().default(""),
  unit_number: z.string().default(""),
  resman_property_id: str,
  status: z.string().default(""),
  priority: z.string().default("Normal"),
  category: z.string().default(""),
  title: z.string().default(""),
  notes: z.string().default(""),
  completion_notes: z.string().default(""),
  technician: z.string().default(""),
  date_reported: str,
  date_scheduled: str,
  date_completed: str,
  is_make_ready: z.boolean().default(false),
  callback_requested: z.boolean().default(false),
  callback_completed: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  is_duplicate: z.boolean().default(false),
  callback_status: z.string().default("none"),
  callback_matched_work_order_id: z.string().default(""),
  callback_engine_version: z.string().default(""),
  callback_source: z.string().default(""),
  callback_detected_at: str,
  synced_at: str,
  created_at: str,
  updated_at: str,
});
export type WorkOrder = z.infer<typeof WorkOrderSchema>;

export const WorkOrderListSchema = z.object({
  data: z.array(WorkOrderSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    count: z.number(),
    hasMore: z.boolean(),
  }),
});
export type WorkOrderList = z.infer<typeof WorkOrderListSchema>;

/**
 * Exactly the columns this module parses, derived from the schema so a field
 * added to one cannot go missing from the other.
 *
 * Without a `columns` param the server answers with the resource's
 * `defaultColumns` — a curated dozen that does NOT include `notes` or
 * `completion_notes`, which back the work order's description and the
 * technician notes on the detail screen. The failure was silent rather than
 * loud: both are declared below with `.default("")`, so a response missing them
 * parsed clean and every work order arrived with both fields blank. There is no
 * by-id detail fetch — the detail screen reads `wo.raw` out of this list's
 * snapshot — so this request is the only place it could be fixed.
 *
 * The server intersects this list against its own public columns, so naming a
 * field it does not expose is ignored rather than an error.
 */
const COLUMNS = Object.keys(WorkOrderSchema.shape).join(",");

export async function listWorkOrders(
  params: {
    limit?: number;
    offset?: number;
    status?: string;
    priority?: string;
    callback_status?: string;
    unit?: string;
    /**
     * ISO timestamp — narrow the result to work orders changed since then. The
     * server compares against a change-detecting `updated_at`, so a quiet poll
     * comes back empty instead of re-sending the whole board.
     */
    updatedSince?: string;
  },
  config: StaffConfig,
): Promise<WorkOrderList> {
  const q = new URLSearchParams();
  q.set("limit", String(params.limit ?? 200));
  q.set("columns", COLUMNS);
  if (params.offset) q.set("offset", String(params.offset));
  if (params.status) q.set("status", params.status);
  if (params.priority) q.set("priority", params.priority);
  if (params.callback_status) q.set("callback_status", params.callback_status);
  if (params.unit) q.set("unit", params.unit);
  if (params.updatedSince) q.set("updated_since", params.updatedSince);

  const res = await fetch(`${config.baseUrl}/api/resman/work-orders?${q.toString()}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (res.status === 401 || res.status === 403)
    throw new Error("Not authorized for the ResMan API");
  if (!res.ok) throw new Error(`Failed to load work orders (${res.status})`);
  return WorkOrderListSchema.parse(await res.json());
}

const CloseResponseSchema = z.object({
  ok: z.boolean(),
  queued: z.boolean().default(false),
  stub: z.boolean().default(false),
});
export type CloseResponse = z.infer<typeof CloseResponseSchema>;

/** Fields the detail screen can edit; all optional, at least one required. */
export interface WorkOrderEditPatch {
  technician?: string;
  description?: string;
  completionNotes?: string;
  /**
   * When the visit is booked, as ISO 8601 — the shape `date_scheduled` already
   * has in the mirror, so the overlay can be compared to the base row without
   * reformatting. `null` clears the booking.
   *
   * The completion date is deliberately NOT here: stamping it closes the work
   * order, which is the close path's job (see `closeWorkOrder`), not a field
   * edit's.
   */
  scheduledAt?: string | null;
}

/**
 * Apply an edit (reassign / description / tech notes) DIRECTLY to ResMan,
 * under the technician's own device-held session — no server in the write
 * path (reads still come from the emberly-web mirror). The write is a form
 * replay, verified by re-reading the form before this resolves, so a resolved
 * promise means the edit is genuinely in ResMan; the mirror catches up on the
 * next sync pass, which is what retires the pending-edits overlay.
 *
 * A refused write (work order Cancelled/Closed, locked field, form drift) is
 * DETERMINISTIC — retrying the same bytes cannot help — and it is also a write
 * that NEVER HAPPENED. It rethrows `WorkOrderWriteRefused` so the pending-edits
 * store can mark the entry BLOCKED: terminal, so the flusher stops re-sending
 * it, but never acked, because acked means "verified in ResMan". Swallowing the
 * refusal as `ok` (what this used to do) retired the entry as Delivered and
 * lost the technician's typed notes behind a green pill — flush() only ever
 * retries un-acked entries. An expired session or offline failure throws too,
 * keeping the entry un-acked and on the automatic retry clock.
 */
export async function editWorkOrder(
  id: string,
  patch: WorkOrderEditPatch,
  _config: StaffConfig,
): Promise<CloseResponse> {
  const outcome = await writeDirect({
    workOrderId: id,
    kind: "edit",
    patch: {
      ...(patch.technician !== undefined ? { technicianName: patch.technician } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.completionNotes !== undefined ? { completionNotes: patch.completionNotes } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
    },
    expectedUnitId: null,
  });
  // Refused = nothing was written. Never report that as ok.
  if (outcome.refused) throw new WorkOrderWriteRefused(outcome.reason);
  if (!outcome.result.ok) throw new Error(outcome.result.detail);
  return { ok: true, queued: false, stub: false };
}

/**
 * Close a work order DIRECTLY in ResMan, under the technician's own
 * device-held session: Status becomes "Completed" (the office's Close stays
 * office work), the completion date is stamped, and CompletedBy follows the
 * assignee the way ResMan's own page does it. Because the session is the
 * tech's, ResMan's audit history records THEM — the original point of
 * device-held sessions. Verified by re-reading the form before this resolves.
 *
 * `completedAt` (ISO 8601) is when the work was actually finished, which is
 * not always now: a tech closing out Friday's job on Monday morning needs the
 * record to say Friday. Omitted means "now", the moment they tapped.
 *
 * A refusal is consumed HERE (the close entry stops retrying) rather than
 * rethrown: several close-only guards — a bad `completedAt`, `refusing to
 * write Status=…` — say nothing about whether the folded EDIT could land, so
 * the edit is left un-acked to get its own verdict from its own flush. Expired
 * sessions and offline failures throw, keeping the entry queued for the next
 * tick.
 */
export async function closeWorkOrder(
  id: string,
  note: string,
  _config: StaffConfig,
  completedAt?: string,
): Promise<CloseResponse> {
  // Coalesce: if this work order also has a pending EDIT (typed notes, a
  // reassignment), fold it into the close so ResMan gets ONE update instead
  // of two form replays. On success the edit is acked as delivered by this
  // request — but only if it still holds exactly what was folded in.
  const { usePendingEdits } = await import("@/lib/stores/pending-edits");
  const pendingEdit = usePendingEdits.getState().pending[id];
  const folded = pendingEdit && !pendingEdit.acked ? pendingEdit.patch : undefined;
  const outcome = await writeDirect({
    workOrderId: id,
    kind: "close",
    patch: {
      ...(folded?.technician !== undefined ? { technicianName: folded.technician } : {}),
      ...(folded?.description !== undefined ? { description: folded.description } : {}),
      ...(folded?.completionNotes !== undefined ? { completionNotes: folded.completionNotes } : {}),
      ...(folded?.scheduledAt !== undefined ? { scheduledAt: folded.scheduledAt } : {}),
      ...(note ? { note } : {}),
      ...(completedAt ? { completedAt } : {}),
    },
    expectedUnitId: null,
  });
  if (!outcome.refused && !outcome.result.ok) throw new Error(outcome.result.detail);
  // Ack the folded edit ONLY when this request genuinely carried it into
  // ResMan — a verified write that actually POSTed. Two outcomes look like
  // success here but wrote nothing:
  //   - refused: a guard said no before any POST, so the fold never happened;
  //   - no-op (`noop`): the engine planned zero changes. That is ambiguous —
  //     either every target was already in ResMan (delivered), or the office
  //     had already Closed the ticket, in which case the close returns BEFORE
  //     applying the folded fields at all (nothing written). The result cannot
  //     tell the two apart, so it counts as NOT delivered: the safe reading
  //     costs one cheap extra write, the unsafe one loses the tech's typed
  //     notes forever, since flush() only ever retries un-acked entries.
  // Either way the edit stays un-acked and gets its OWN verdict from its own
  // flush, which terminates three ways: the write lands and acks; it no-ops
  // and acks; or ResMan refuses it, and the entry goes BLOCKED — still not
  // acked, still in the outbox, now carrying the reason (see PendingEdit).
  //
  // And when we DO ack, ack against what the close actually WROTE, not what
  // was asked: the engine's close writes its own note over any folded typed
  // notes (`patch.note` wins in mutate()), so acking with the superseded draft
  // would leave a completionNotes ResMan never received — unabsorbable, and
  // half an hour later the redeliver clock would re-POST the stale draft OVER
  // the close note. The re-base is only sound because it sits behind the
  // delivered check above: a verified non-no-op POST is exactly the case where
  // `note` is what ResMan now holds.
  if (folded && !outcome.refused && outcome.result.ok && !outcome.result.noop) {
    const written =
      note && folded.completionNotes !== undefined ? { ...folded, completionNotes: note } : folded;
    usePendingEdits.getState().ackDelivered(id, folded, written);
  }
  return { ok: true, queued: false, stub: false };
}

/**
 * The two shapes a direct write can settle in. A refusal is NOT an engine
 * verdict — no POST was sent — so it is kept separate rather than flattened
 * into a falsy result the caller can mistake for success.
 */
type WriteOutcome =
  { refused: false; result: WorkOrderWriteResult } | { refused: true; reason: string };

/**
 * Run one direct write, reporting a deterministic refusal as data instead of
 * an exception so each wrapper can decide what it means for ITS queue entry
 * (analytics carry the reason — no free text, AGENTS.md keeps notes out of
 * logs).
 */
async function writeDirect(request: WorkOrderWriteRequest): Promise<WriteOutcome> {
  const { writeWorkOrderDirect } = await import("@/lib/resman/work-order-write");
  try {
    return { refused: false, result: await writeWorkOrderDirect(request) };
  } catch (error) {
    if (error instanceof WorkOrderWriteRefused) {
      const { capture } = await import("@/lib/analytics");
      capture("work_order_write_refused", { kind: request.kind, reason: error.message });
      return { refused: true, reason: error.message };
    }
    throw error;
  }
}

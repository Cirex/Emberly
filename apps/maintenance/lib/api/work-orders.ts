import { z } from "zod";
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
  if (params.offset) q.set("offset", String(params.offset));
  if (params.status) q.set("status", params.status);
  if (params.priority) q.set("priority", params.priority);
  if (params.callback_status) q.set("callback_status", params.callback_status);
  if (params.unit) q.set("unit", params.unit);
  if (params.updatedSince) q.set("updated_since", params.updatedSince);

  const res = await fetch(`${config.baseUrl}/api/resman/work-orders?${q.toString()}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (res.status === 401 || res.status === 403) throw new Error("Not authorized for the ResMan API");
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
 * Ask the server to apply an edit (reassign / description / tech notes). The
 * server side is a STUB today — it validates and answers { queued: true }
 * without touching ResMan. The app renders the edited values optimistically
 * as "pending sync" via the pending-edits overlay store.
 */
export async function editWorkOrder(
  id: string,
  patch: WorkOrderEditPatch,
  config: StaffConfig,
): Promise<CloseResponse> {
  const res = await fetch(
    `${config.baseUrl}/api/resman/work-orders/${encodeURIComponent(id)}/edit`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (res.status === 404) throw new Error("Work order not found");
  if (res.status === 401 || res.status === 403) throw new Error("Not authorized for the ResMan API");
  if (!res.ok) throw new Error(`Failed to edit work order (${res.status})`);
  return CloseResponseSchema.parse(await res.json());
}

/**
 * Ask the server to close a work order. The server side is a STUB today —
 * it validates and answers { queued: true } without touching ResMan (see the
 * route's TODO). The app treats a queued close as "Closed · pending ResMan".
 *
 * `completedAt` (ISO 8601) is when the work was actually finished, which is
 * not always now: a tech closing out Friday's job on Monday morning needs the
 * record to say Friday. Omitted means "the server decides", preserving the
 * behaviour of every caller that just marks a job complete on the spot.
 */
export async function closeWorkOrder(
  id: string,
  note: string,
  config: StaffConfig,
  completedAt?: string,
): Promise<CloseResponse> {
  const res = await fetch(
    `${config.baseUrl}/api/resman/work-orders/${encodeURIComponent(id)}/close`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...(note ? { note } : {}), ...(completedAt ? { completedAt } : {}) }),
    },
  );
  if (res.status === 404) throw new Error("Work order not found");
  if (res.status === 401 || res.status === 403) throw new Error("Not authorized for the ResMan API");
  if (!res.ok) throw new Error(`Failed to close work order (${res.status})`);
  return CloseResponseSchema.parse(await res.json());
}

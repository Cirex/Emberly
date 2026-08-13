import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * GET /api/resman/work-orders — the `resman_work_orders` mirror, read with the
 * signed-in staff member's Bearer token (the same private ResMan REST API the
 * maintenance app reads; see apps/maintenance/lib/api/work-orders.ts).
 *
 * MANAGER CUT: read-only. The maintenance app owns the close/edit writes and
 * the photo seam; this app is an oversight surface, so only the list read is
 * ported. The full row is kept because the detail sheet shows description,
 * completion notes and dates verbatim.
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

/** The API's hard page cap. */
export const WORK_ORDER_PAGE = 200;

/** One page of the mirror. Throws ApiError / ZodError; callers contain. */

/**
 * Exactly the columns this module parses, derived from the schema so a field
 * added to one cannot go missing from the other.
 *
 * Without a `columns` param the server answers with the resource's
 * `defaultColumns` — a curated subset that withholds `notes`, `completion_notes`, `is_make_ready`, `tags` and every callback
 * column — 19 of the 30 fields below.
 * The withheld fields then arrive undefined and this schema's
 * optional/default declarations absorb them without complaint: no parse error,
 * no warning, just empty values reaching the UI.
 *
 * The server intersects this list against its own public columns, so naming a
 * field it does not expose is ignored rather than an error.
 */
const COLUMNS = Object.keys(WorkOrderSchema.shape).join(",");

export async function listWorkOrders(
  params: { limit?: number; offset?: number },
  config: StaffConfig,
): Promise<WorkOrderList> {
  const q = new URLSearchParams();
  q.set("limit", String(params.limit ?? WORK_ORDER_PAGE));
  q.set("columns", COLUMNS);
  if (params.offset) q.set("offset", String(params.offset));
  const json = await apiJson(`/api/resman/work-orders?${q.toString()}`, config);
  return WorkOrderListSchema.parse(json);
}

/**
 * Every page of the unfiltered set. The manager's boards band and group the
 * whole mirror on device (open / make ready / closed all come from one read),
 * so paging here is simpler than three filtered reads.
 */
export async function fetchAllWorkOrders(config: StaffConfig): Promise<WorkOrder[]> {
  const acc: WorkOrder[] = [];
  let offset = 0;
  for (;;) {
    const res = await listWorkOrders({ limit: WORK_ORDER_PAGE, offset }, config);
    acc.push(...res.data);
    if (!res.pagination.hasMore) break;
    offset += WORK_ORDER_PAGE;
    if (offset > 40_000) break; // safety valve
  }
  return acc;
}

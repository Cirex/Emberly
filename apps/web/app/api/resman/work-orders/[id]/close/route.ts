import { NextResponse } from "next/server";
import { getResource } from "@/lib/resman-api";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { workOrdersResource } from "@/lib/resman-resources";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import { queueWorkOrderWrite, workOrderWriteActor } from "@/lib/work-order-write-queue";

/**
 * POST /api/resman/work-orders/[id]/close — queue a work-order close for ResMan.
 *
 * The OFFICE-SIDE / fallback write path. The maintenance app closes work
 * orders in ResMan DIRECTLY from the device under the technician's own
 * session (so ResMan's audit trail records the tech) and does not call this
 * route; it remains for office tooling and any client without a device-held
 * ResMan session. ResMan is the system of record, and this route never
 * touches it inline: it validates the work order exists and appends a durable
 * row to `maintenance_work_order_edits`, which the sync worker's
 * flush-work-order-writes job replays against ResMan's edit form — Status
 * becomes "Completed" (the office's Close stays office work), the completion
 * date is stamped, and ResMan credits the ASSIGNED technician
 * (CompletedByPersonID follows AssignedToPersonID). When the caller did not
 * stamp a completion date, the flush uses this row's created_at — the moment
 * it was requested, not the moment the queue drained. Never write
 * resman_work_orders directly.
 *
 * Staff-token only: a scanner is a gate device, not a maintenance tool.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind !== "token") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let note = "";
  let completedAt: string | null = null;
  try {
    const body = (await request.json()) as { note?: unknown; completedAt?: unknown };
    if (typeof body.note === "string") note = body.note.slice(0, 2000);
    // When the tech stamped the completion date themselves it rides along, so
    // a job finished Friday and closed out Monday records Friday. Anything
    // unparseable is dropped rather than 400'd — the close still matters.
    if (typeof body.completedAt === "string" && !Number.isNaN(Date.parse(body.completedAt))) {
      completedAt = new Date(body.completedAt).toISOString();
    }
  } catch {
    /* empty body is fine */
  }

  try {
    const { id } = await context.params;
    const client = createAdminClient() as UntypedSupabase;
    const row = await getResource(workOrdersResource, id, client, false);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await queueWorkOrderWrite(client, {
      workOrderId: id,
      kind: "close",
      patch: { ...(note ? { note } : {}), ...(completedAt ? { completedAt } : {}) },
      actor: workOrderWriteActor(auth),
    });
    // Never log `note` — it is free text that can carry unit/resident details
    // (AGENTS.md: keep request bodies out of logs). Record only that a note
    // was present, not its contents. A date is not free text, so it can be logged.
    console.info(
      `[resman-api work-orders close] queued close for ${id}${note ? " (with note)" : ""}` +
        `${completedAt ? ` (completed ${completedAt})` : ""}`,
    );
    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    console.error("[resman-api work-orders close] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

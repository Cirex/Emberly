import { NextResponse } from "next/server";
import { getResource } from "@/lib/resman-api";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { workOrdersResource } from "@/lib/resman-resources";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import { queueWorkOrderWrite, workOrderWriteActor } from "@/lib/work-order-write-queue";

/**
 * POST /api/resman/work-orders/[id]/edit — queue a work-order edit for ResMan.
 *
 * The OFFICE-SIDE / fallback write path. The maintenance app writes to ResMan
 * DIRECTLY from the device under the technician's own session (so ResMan's
 * audit trail records the tech) and does not call this route; it remains for
 * office tooling and any client without a device-held ResMan session. ResMan
 * is the system of record, and this route never touches it inline: it
 * validates the work order exists and appends a durable row to
 * `maintenance_work_order_edits`, which the sync worker's
 * flush-work-order-writes job replays against ResMan's edit form (edits and
 * closes only — delete and cancel are refused by the writer). Never write
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

  const patch: {
    technician?: string;
    description?: string;
    completionNotes?: string;
    scheduledAt?: string | null;
  } = {};
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.technician === "string") patch.technician = body.technician.slice(0, 200);
    if (typeof body.description === "string") patch.description = body.description.slice(0, 8000);
    if (typeof body.completionNotes === "string") {
      patch.completionNotes = body.completionNotes.slice(0, 8000);
    }
    // The booked visit. `null` is a real value here — it clears the booking —
    // so it is accepted distinctly from "absent", which means "leave it alone".
    if (body.scheduledAt === null) patch.scheduledAt = null;
    else if (typeof body.scheduledAt === "string" && !Number.isNaN(Date.parse(body.scheduledAt))) {
      patch.scheduledAt = new Date(body.scheduledAt).toISOString();
    }
  } catch {
    /* fall through to the empty-patch check */
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to edit" }, { status: 400 });
  }

  try {
    const { id } = await context.params;
    const client = createAdminClient() as UntypedSupabase;
    const row = await getResource(workOrdersResource, id, client, false);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await queueWorkOrderWrite(client, {
      workOrderId: id,
      kind: "edit",
      patch,
      actor: workOrderWriteActor(auth),
    });
    // Field names only — description/notes are free text that can carry
    // unit/resident details (AGENTS.md: keep request bodies out of logs).
    console.info(
      `[resman-api work-orders edit] queued edit for ${id} (fields: ${Object.keys(patch).join(", ")})`,
    );
    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    console.error("[resman-api work-orders edit] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

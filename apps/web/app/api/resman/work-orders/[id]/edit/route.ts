import { NextResponse } from "next/server";
import { getResource } from "@/lib/resman-api";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { workOrdersResource } from "@/lib/resman-resources";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * POST /api/resman/work-orders/[id]/edit — STUB of the write path.
 *
 * The maintenance app calls this when a technician reassigns a work order or
 * edits its description / technician notes from the detail screen. ResMan is
 * the system of record, and we do not write to it yet: this validates the
 * work order exists and answers `{ queued: true, stub: true }` so the app can
 * render the edited values optimistically ("pending sync").
 *
 * Real implementation (per apps/maintenance/README.md "deferred write path"):
 * upsert a maintenance_work_order_edits overlay row (edited_by from the
 * token) and push the change to ResMan; the sync then absorbs it. Never
 * write resman_work_orders directly.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;

  const patch: { technician?: string; description?: string; completionNotes?: string } = {};
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.technician === "string") patch.technician = body.technician.slice(0, 200);
    if (typeof body.description === "string") patch.description = body.description.slice(0, 8000);
    if (typeof body.completionNotes === "string") {
      patch.completionNotes = body.completionNotes.slice(0, 8000);
    }
  } catch {
    /* fall through to the empty-patch check */
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to edit" }, { status: 400 });
  }

  try {
    const { id } = await context.params;
    const row = await getResource(
      workOrdersResource,
      id,
      createAdminClient() as UntypedSupabase,
      auth.kind === "scanner",
    );
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // TODO(resman-write): queue the actual ResMan update + overlay row here.
    console.info(
      `[resman-api work-orders edit] STUB queued edit for ${id} (fields: ${Object.keys(patch).join(", ")})`,
    );
    return NextResponse.json({ ok: true, queued: true, stub: true });
  } catch (error) {
    console.error("[resman-api work-orders edit] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

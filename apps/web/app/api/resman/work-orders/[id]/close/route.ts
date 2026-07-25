import { NextResponse } from "next/server";
import { getResource } from "@/lib/resman-api";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { workOrdersResource } from "@/lib/resman-resources";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * POST /api/resman/work-orders/[id]/close — STUB of the write path.
 *
 * The maintenance app calls this when a technician closes a work order from
 * their path. ResMan is the system of record, and we do not write to it yet:
 * this validates the work order exists and answers `{ queued: true, stub:
 * true }` so the app can render "Closed · pending ResMan" optimistically.
 *
 * Real implementation (per apps/maintenance/README.md "deferred write path"):
 * upsert a maintenance_work_order_edits overlay row (status "Closed",
 * edited_by from the token) and push the close to ResMan; the sync then
 * absorbs it. Never write resman_work_orders directly.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;

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
    const row = await getResource(
      workOrdersResource,
      id,
      createAdminClient() as UntypedSupabase,
      auth.kind === "scanner",
    );
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // TODO(resman-write): queue the actual ResMan close + overlay row here,
    // stamping date_completed from `completedAt` when present and now() when not.
    // Never log `note` — it is free text that can carry unit/resident details
    // (AGENTS.md: keep request bodies out of logs). Record only that a note was
    // present, not its contents. A date is not free text, so it can be logged.
    console.info(
      `[resman-api work-orders close] STUB queued close for ${id}${note ? " (with note)" : ""}` +
        `${completedAt ? ` (completed ${completedAt})` : ""}`,
    );
    return NextResponse.json({ ok: true, queued: true, stub: true });
  } catch (error) {
    console.error("[resman-api work-orders close] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

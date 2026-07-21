import { NextResponse } from "next/server";
import { z } from "zod";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { pmTaskStatusPatch, updatePmTaskStatus } from "@/lib/pm-tasks";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * POST /api/resman/pm-tasks/[id] — check a preventive-maintenance task off
 * (or skip it, or put it back). done/skipped stamp completed_at plus
 * completed_by — the caller's explicit name when provided, else the token
 * label, following how work-order photos attribute actors; "pending" clears
 * both. Staff-token only (scanners are gate devices) — an Emberly-only write,
 * ResMan is never touched.
 */

const UpdateSchema = z.object({
  status: z.enum(["pending", "done", "skipped"]),
  completedBy: z.string().trim().max(120).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const { id } = await params;
    const patch = pmTaskStatusPatch(
      parsed.data.status,
      auth.subject.label,
      parsed.data.completedBy,
      Date.now(),
    );
    const client = createUntypedAdminClient();
    const task = await updatePmTaskStatus(client, id, patch);
    if (!task) return NextResponse.json({ error: "PM task not found" }, { status: 404 });

    return NextResponse.json({
      data: {
        id: task.id,
        templateId: task.template_id,
        roundKey: task.round_key,
        unitNumber: task.unit_number,
        status: task.status,
        completedBy: task.completed_by,
        completedAt: task.completed_at,
      },
    });
  } catch (error) {
    console.error("[resman-api pm-tasks] Update error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Admin API — edit or delete one PM template.
 *   PATCH  /api/admin/pm-templates/{id} — update any editable field (incl. active)
 *   DELETE /api/admin/pm-templates/{id} — delete (pm_tasks cascade in the DB)
 *
 * Gated to super_admin, same as /api/admin/admins: templates fan out into
 * property-wide task rounds, so changing or deleting one is privileged.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import {
  deletePmTemplate,
  normalizeScopeValues,
  updatePmTemplate,
  type PmTemplatePatch,
} from "@/lib/pm-templates";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TemplatePatchSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200).optional(),
  category: z.string().trim().max(120).optional(),
  cadence: z.enum(["monthly", "quarterly", "semiannual", "annual"]).optional(),
  anchorMonth: z.number().int().min(1).max(12).nullable().optional(),
  scopeType: z.enum(["all", "building", "classification"]).optional(),
  scopeValues: z.array(z.string().max(120)).max(50).optional(),
  active: z.boolean().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const auth = await requireAdmin(request, { roles: ["super_admin"] });
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing template id" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TemplatePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const patch: PmTemplatePatch = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.category !== undefined) patch.category = parsed.data.category;
  if (parsed.data.cadence !== undefined) patch.cadence = parsed.data.cadence;
  if (parsed.data.anchorMonth !== undefined) patch.anchorMonth = parsed.data.anchorMonth;
  if (parsed.data.scopeType !== undefined) patch.scopeType = parsed.data.scopeType;
  if (parsed.data.scopeValues !== undefined) {
    patch.scopeValues = normalizeScopeValues(parsed.data.scopeValues);
  }
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const template = await updatePmTemplate(client, id, patch);
    if (!template) {
      return NextResponse.json({ error: "PM template not found" }, { status: 404 });
    }
    return NextResponse.json({ data: template });
  } catch (error) {
    console.error("[admin/pm-templates PATCH]", error);
    return NextResponse.json({ error: "Failed to update PM template" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  const auth = await requireAdmin(request, { roles: ["super_admin"] });
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing template id" }, { status: 400 });

  try {
    const client = createUntypedAdminClient();
    const deleted = await deletePmTemplate(client, id);
    if (!deleted) {
      return NextResponse.json({ error: "PM template not found" }, { status: 404 });
    }
    return NextResponse.json({ data: { id } });
  } catch (error) {
    console.error("[admin/pm-templates DELETE]", error);
    return NextResponse.json({ error: "Failed to delete PM template" }, { status: 500 });
  }
}

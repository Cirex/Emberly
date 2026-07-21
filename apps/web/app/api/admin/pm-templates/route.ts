/**
 * Admin API for preventive-maintenance templates.
 *   GET  /api/admin/pm-templates — templates with round stats + header summary
 *   POST /api/admin/pm-templates — create a template
 *
 * Reads are open to any authenticated admin; writes are super_admin-only
 * (defining property-wide recurring work is a privileged act), mirroring the
 * /api/admin/admins gating. The nightly sync worker — not this API — expands
 * active templates into pm_tasks rounds.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import {
  createPmTemplate,
  listPmOverview,
  normalizeScopeValues,
} from "@/lib/pm-templates";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TemplateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  category: z.string().trim().max(120).optional(),
  cadence: z.enum(["monthly", "quarterly", "semiannual", "annual"]),
  anchorMonth: z.number().int().min(1).max(12).nullable().optional(),
  scopeType: z.enum(["all", "building", "classification"]).optional(),
  scopeValues: z.array(z.string().max(120)).max(50).optional(),
  active: z.boolean().optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const client = createUntypedAdminClient();
    const data = await listPmOverview(client);
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[admin/pm-templates GET]", error);
    return NextResponse.json({ error: "Failed to load PM templates" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireAdmin(request, { roles: ["super_admin"] });
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TemplateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const client = createUntypedAdminClient();
    const template = await createPmTemplate(
      client,
      {
        name: parsed.data.name,
        category: parsed.data.category ?? "",
        cadence: parsed.data.cadence,
        anchorMonth: parsed.data.anchorMonth ?? null,
        scopeType: parsed.data.scopeType ?? "all",
        scopeValues: normalizeScopeValues(parsed.data.scopeValues ?? []),
        active: parsed.data.active ?? true,
      },
      auth.admin.displayName,
    );
    return NextResponse.json({ data: template }, { status: 201 });
  } catch (error) {
    console.error("[admin/pm-templates POST]", error);
    return NextResponse.json({ error: "Failed to create PM template" }, { status: 500 });
  }
}

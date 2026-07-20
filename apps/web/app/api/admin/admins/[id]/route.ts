/**
 * Admin API — change one admin user's role.
 *   PATCH /api/admin/admins/{id}  body: { role }
 *
 * Gated to super_admin (granting privileges must itself be privileged). Refuses
 * an unknown role and refuses to demote the last active super_admin (which would
 * lock everyone out of the super_admin-only surfaces, including this one).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { isAssignableAdminRole, updateAdminUserRole } from "@/lib/admin-users";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(request, { roles: ["super_admin"] });
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing admin id" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (!isAssignableAdminRole(role)) {
    return NextResponse.json({ error: "Unknown role" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const result = await updateAdminUserRole(client, id, role);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return NextResponse.json({ error: "Admin user not found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "Cannot demote the last active super_admin" },
        { status: 409 },
      );
    }
    return NextResponse.json({ data: result.admin });
  } catch (error) {
    console.error("[admin/admins PATCH]", error);
    return NextResponse.json({ error: "Failed to update role" }, { status: 500 });
  }
}

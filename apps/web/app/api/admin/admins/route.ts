/**
 * Admin API for the admin_users directory.
 *   GET /api/admin/admins — list admin users (role, status, last login)
 *
 * Gated to super_admin: the roster reveals who holds which privileges, and this
 * endpoint backs the role-management surface. Role edits live at
 * /api/admin/admins/[id] (PATCH).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { listAdminUsers } from "@/lib/admin-users";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireAdmin(request, { roles: ["super_admin"] });
  if (!auth.ok) return auth.response;
  try {
    const client = createUntypedAdminClient();
    const data = await listAdminUsers(client);
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[admin/admins GET]", error);
    return NextResponse.json({ error: "Failed to load admin users" }, { status: 500 });
  }
}

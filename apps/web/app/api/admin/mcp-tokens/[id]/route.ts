/**
 * Admin API — revoke a single MCP staff token.
 *   DELETE /api/admin/mcp-tokens/{id}  — mark active=false, revoked_at=now
 * Gated by the admin session (requireAdmin). Revocation is immediate: the next
 * request carrying that token fails auth.
 */
import { NextResponse } from "next/server";
import { revokeAccessToken } from "@/lib/access-tokens";
import { requireAdmin } from "@/lib/admin-request";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing token id" }, { status: 400 });

  try {
    const client = createUntypedAdminClient();
    const revoked = await revokeAccessToken(client, id);
    if (!revoked) return NextResponse.json({ error: "Token not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[admin/mcp-tokens DELETE]", error);
    return NextResponse.json({ error: "Failed to revoke token" }, { status: 500 });
  }
}

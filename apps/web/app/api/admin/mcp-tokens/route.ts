/**
 * Admin API for managing MCP staff bearer tokens (access_tokens, kind='mcp').
 *   GET  /api/admin/mcp-tokens        — list MCP tokens (no secrets)
 *   POST /api/admin/mcp-tokens        — mint one (returns plaintext once)
 * Gated by the admin session (requireAdmin).
 */
import { NextResponse } from "next/server";
import { listAccessTokens, mintAccessToken } from "@/lib/access-tokens";
import { requireAdmin } from "@/lib/admin-request";
import { RESMAN_RESOURCES } from "@/lib/resman-resources";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCE_NAMES = new Set(RESMAN_RESOURCES.map((r) => r.name));

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const client = createUntypedAdminClient();
    const tokens = await listAccessTokens(client, { subjectType: "admin_user" });
    // Map to the UI's { staff_id, staff_name } shape.
    const data = tokens.map((t) => ({
      id: t.id,
      kind: t.kind,
      staff_id: t.subject_id,
      staff_name: t.label,
      role: t.role,
      token_prefix: t.token_prefix,
      scopes: t.scopes,
      active: t.active,
      last_used_at: t.last_used_at,
      created_at: t.created_at,
      revoked_at: t.revoked_at,
    }));
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[admin/mcp-tokens GET]", error);
    return NextResponse.json({ error: "Failed to load tokens" }, { status: 500 });
  }
}

/** Roles this endpoint may stamp onto a minted token. */
const MINTABLE_ROLES = new Set(["super_admin", "property_manager", "security_manager", "viewer"]);

export async function POST(request: Request): Promise<NextResponse> {
  // Minting a bearer token grants standing API access, so only a super_admin
  // may do it — otherwise any admin (now including read-only viewers) could
  // mint themselves a privileged token. super_admin always passes the gate.
  const auth = await requireAdmin(request, { roles: ["super_admin"] });
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const staffId = typeof body.staffId === "string" ? body.staffId.trim() : "";
  const staffName = typeof body.staffName === "string" ? body.staffName.trim() : "";
  // Validate the requested role against the known set (default: least
  // privilege) so a crafted body can't stamp an arbitrary/unknown role.
  const requestedRole = typeof body.role === "string" ? body.role.trim() : "";
  const role = MINTABLE_ROLES.has(requestedRole) ? requestedRole : "viewer";
  const kind = body.kind === "api_resman" ? "api_resman" : "mcp";
  const scopesRaw = Array.isArray(body.scopes) ? body.scopes : [];
  const scopes = scopesRaw.filter((s): s is string => typeof s === "string" && RESOURCE_NAMES.has(s));

  if (!staffId || !staffName) {
    return NextResponse.json({ error: "staffId and staffName are required" }, { status: 400 });
  }
  if (scopesRaw.length > 0 && scopes.length !== scopesRaw.length) {
    return NextResponse.json({ error: "One or more scopes are not valid resource names" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const minted = await mintAccessToken(client, {
      kind,
      subjectType: "admin_user",
      subjectId: staffId,
      label: staffName,
      role,
      scopes,
    });
    return NextResponse.json({ data: minted }, { status: 201 });
  } catch (error) {
    console.error("[admin/mcp-tokens POST]", error);
    return NextResponse.json({ error: "Failed to mint token" }, { status: 500 });
  }
}

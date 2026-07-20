import { NextRequest, NextResponse } from "next/server";
import {
  buildAccessAuditInsert,
  buildRevokedKeyPatch,
  MAP_SYNC_MANAGER_ROLES,
} from "@/lib/map-sync-access";
import { requireAdmin } from "@/lib/admin-request";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ keyId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: MAP_SYNC_MANAGER_ROLES });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  try {
    const { keyId } = await params;
    const supabase = createUntypedAdminClient();
    const { data: syncKey, error: loadError } = await supabase
      .from("map_sync_keys")
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, requester_resman_login_hash, device_id, active")
      .eq("id", keyId)
      .maybeSingle();

    if (loadError) {
      console.error("[map/admin/sync-keys revoke] Load error:", loadError);
      return NextResponse.json({ error: "Failed to load sync key" }, { status: 500 });
    }
    if (!syncKey) {
      return NextResponse.json({ error: "Sync key not found" }, { status: 404 });
    }
    if (!syncKey.active) {
      return NextResponse.json({ error: "Sync key is already revoked" }, { status: 409 });
    }

    const revokedAt = new Date().toISOString();
    const { data: revokedKey, error: revokeError } = await supabase
      .from("map_sync_keys")
      .update(buildRevokedKeyPatch(admin, revokedAt))
      .eq("id", keyId)
      .eq("active", true)
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, device_id, active, revoked_by, revoked_at")
      .maybeSingle();

    if (revokeError || !revokedKey) {
      console.error("[map/admin/sync-keys revoke] Update error:", revokeError);
      return NextResponse.json({ error: "Failed to revoke sync key" }, { status: 409 });
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAccessAuditInsert("access.revoke", syncKey, admin, { syncKeyId: keyId }));

    if (auditError) {
      console.error("[map/admin/sync-keys revoke] Audit error:", auditError);
    }

    return NextResponse.json({
      key: revokedKey,
    });
  } catch (error) {
    console.error("[map/admin/sync-keys revoke] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

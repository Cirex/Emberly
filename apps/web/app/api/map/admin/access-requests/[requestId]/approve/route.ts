import { NextRequest, NextResponse } from "next/server";
import {
  buildAccessAuditInsert,
  buildApprovedRequestPatch,
  MAP_SYNC_MANAGER_ROLES,
} from "@/lib/map-sync-access";
import { requireAdmin } from "@/lib/admin-request";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ requestId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: MAP_SYNC_MANAGER_ROLES });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  try {
    const { requestId } = await params;
    const supabase = createUntypedAdminClient();
    const { data: accessRequest, error: loadError } = await supabase
      .from("map_sync_access_requests")
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, requester_resman_login_hash, device_id, status")
      .eq("id", requestId)
      .maybeSingle();

    if (loadError) {
      console.error("[map/admin/access-requests approve] Load error:", loadError);
      return NextResponse.json({ error: "Failed to load access request" }, { status: 500 });
    }
    if (!accessRequest) {
      return NextResponse.json({ error: "Access request not found" }, { status: 404 });
    }
    if (accessRequest.status !== "pending") {
      return NextResponse.json(
        { error: "Access request is not pending", status: accessRequest.status },
        { status: 409 },
      );
    }

    const approvedAt = new Date().toISOString();
    const { data: approvedRequest, error: approveError } = await supabase
      .from("map_sync_access_requests")
      .update(buildApprovedRequestPatch(admin, approvedAt))
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, requester_resman_login_hash, device_id, status, approved_by, approved_at")
      .maybeSingle();

    if (approveError || !approvedRequest) {
      console.error("[map/admin/access-requests approve] Update error:", approveError);
      return NextResponse.json({ error: "Failed to approve access request" }, { status: 409 });
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAccessAuditInsert("access.approve", accessRequest, admin));

    if (auditError) {
      console.error("[map/admin/access-requests approve] Audit error:", auditError);
    }

    return NextResponse.json({
      request: approvedRequest,
    });
  } catch (error) {
    console.error("[map/admin/access-requests approve] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

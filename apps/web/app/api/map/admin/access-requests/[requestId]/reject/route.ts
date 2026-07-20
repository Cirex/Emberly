import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/lib/http";
import {
  buildAccessAuditInsert,
  buildRejectedRequestPatch,
  MAP_SYNC_MANAGER_ROLES,
} from "@/lib/map-sync-access";
import { requireAdmin } from "@/lib/admin-request";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ requestId: string }>;
}

const RejectRequestSchema = z.object({
  rejectionReason: z.string().trim().min(1).max(500).optional().nullable(),
});

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: MAP_SYNC_MANAGER_ROLES });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  try {
    const body = await readJson(request);
    if (!body.ok) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const parsed = RejectRequestSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const rejectionReason = parsed.data.rejectionReason?.trim() || null;
    const { requestId } = await params;
    const supabase = createUntypedAdminClient();
    const { data: accessRequest, error: loadError } = await supabase
      .from("map_sync_access_requests")
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, requester_resman_login_hash, device_id, status, rejection_reason")
      .eq("id", requestId)
      .maybeSingle();

    if (loadError) {
      console.error("[map/admin/access-requests reject] Load error:", loadError);
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

    const rejectedAt = new Date().toISOString();
    const { data: rejectedRequest, error: rejectError } = await supabase
      .from("map_sync_access_requests")
      .update(buildRejectedRequestPatch(admin, rejectedAt, rejectionReason))
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, requester_resman_login_hash, device_id, status, rejected_by, rejected_at, rejection_reason")
      .maybeSingle();

    if (rejectError || !rejectedRequest) {
      console.error("[map/admin/access-requests reject] Update error:", rejectError);
      return NextResponse.json({ error: "Failed to reject access request" }, { status: 409 });
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAccessAuditInsert("access.reject", accessRequest, admin, { rejectionReason }));

    if (auditError) {
      console.error("[map/admin/access-requests reject] Audit error:", auditError);
    }

    return NextResponse.json({
      request: rejectedRequest,
    });
  } catch (error) {
    console.error("[map/admin/access-requests reject] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

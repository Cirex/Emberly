import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { recordAdminAuditLog } from "@/lib/admin-audit";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const { id } = await params;
  const supabase = createUntypedAdminClient();
  const { data, error } = await supabase
    .from("admin_alerts")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: admin.displayName,
    })
    .eq("id", id)
    .select("id, alert_type, status, resolved_at, resolved_by")
    .single();

  if (error || !data) {
    console.error("[admin/alerts resolve] Update error:", error);
    return NextResponse.json({ error: "Failed to resolve alert" }, { status: 500 });
  }

  await recordAdminAuditLog(supabase, admin, {
    action: "alert.resolve",
    targetType: "alert",
    targetId: id,
    metadata: { alertType: data.alert_type },
  });

  return NextResponse.json({ alert: data });
}

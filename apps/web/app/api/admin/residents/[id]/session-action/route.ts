import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { recordAdminAuditLog } from "@/lib/admin-audit";
import { buildResidentSessionActionUpdate } from "@/lib/admin-operations";
import { revokeResidentDeviceSessions } from "@/lib/resident-devices";
import { createAdminClient } from "@/lib/supabase/admin";

const ActionSchema = z.object({
  action: z.enum(["require_reauth", "suspend_access"]),
});

const AuditActionByResidentAction = {
  require_reauth: "resident.require_reauth",
  suspend_access: "resident.suspend_access",
} as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: ["property_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const parsed = ActionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id: residentId } = await params;
  const supabase = createAdminClient();

  const update = buildResidentSessionActionUpdate(parsed.data.action);

  const { data, error } = await supabase
    .from("residents")
    .update(update)
    .eq("id", residentId)
    .select("id, name, access_allowed, access_status, last_resman_verified_at, updated_at")
    .single();

  if (error || !data) {
    console.error("[admin/resident session-action] Update error:", error);
    return NextResponse.json({ error: "Failed to update resident session state" }, { status: 500 });
  }

  try {
    await revokeResidentDeviceSessions(supabase, residentId);
  } catch (error) {
    console.error("[admin/resident session-action] Device revocation error:", error);
    return NextResponse.json({ error: "Failed to revoke resident device sessions" }, { status: 500 });
  }

  await recordAdminAuditLog(supabase, admin, {
    action: AuditActionByResidentAction[parsed.data.action],
    targetType: "resident",
    targetId: residentId,
    metadata: {
      residentName: data.name,
      accessStatus: data.access_status,
    },
  });

  return NextResponse.json({ resident: data });
}

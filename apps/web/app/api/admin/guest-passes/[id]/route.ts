import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { recordAdminAuditLog } from "@/lib/admin-audit";
import { getGuestPassStatus } from "@/lib/admin-data";
import { createAdminClient } from "@/lib/supabase/admin";

const GuestPassPatchSchema = z.object({
  expiresAt: z.string().datetime().optional(),
  status: z.enum(["revoked"]).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdminOrScanner(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const parsed = GuestPassPatchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const update: { expires_at?: string; status?: "revoked" } = {};
  if (parsed.data.expiresAt) update.expires_at = parsed.data.expiresAt;
  if (parsed.data.status) update.status = "revoked";

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  const { id } = await params;
  const supabase = createAdminClient();

  if (update.expires_at) {
    const { data: existing, error: existingError } = await supabase
      .from("guest_passes")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();

    if (existingError) {
      console.error("[admin/guest-pass PATCH] Lookup error:", existingError);
      return NextResponse.json({ error: "Failed to update guest pass" }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Guest pass not found" }, { status: 404 });
    }
    if (existing.status !== "active") {
      return NextResponse.json(
        { error: `Cannot change the expiry of a ${existing.status} guest pass` },
        { status: 409 }
      );
    }
  }

  let updateQuery = supabase
    .from("guest_passes")
    .update(update)
    .eq("id", id);
  if (update.expires_at) {
    // Guards the check above against a concurrent revoke/use of the pass.
    updateQuery = updateQuery.eq("status", "active");
  }
  const { data, error } = await updateQuery
    .select("id, guest_name, guest_email, expires_at, used_at, status, created_at")
    .single();

  if (error || !data) {
    console.error("[admin/guest-pass PATCH] Update error:", error);
    return NextResponse.json({ error: "Failed to update guest pass" }, { status: 500 });
  }

  await recordAdminAuditLog(supabase, admin, {
    action: "guest_pass.update",
    targetType: "guest_pass",
    targetId: id,
    metadata: update,
  });

  return NextResponse.json({
    pass: {
      ...data,
      status: getGuestPassStatus(data),
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { recordAdminAuditLog } from "@/lib/admin-audit";
import { createAdminClient } from "@/lib/supabase/admin";

const SuspensionSchema = z.object({
  reason: z.string().max(500).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: ["property_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const { id: residentId } = await params;

  try {
    const body = await request.json();
    const parsed = SuspensionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Verify resident exists
    const { data: resident, error: residentError } = await supabase
      .from("residents")
      .select("id, name")
      .eq("id", residentId)
      .single();

    if (residentError || !resident) {
      return NextResponse.json({ error: "Resident not found" }, { status: 404 });
    }

    // Upsert creation-suspension record (idempotent)
    const { data: ban, error: banError } = await supabase
      .from("guest_pass_bans")
      .upsert(
        {
          resident_id: residentId,
          reason: parsed.data.reason ?? null,
          banned_by: admin.displayName,
          banned_at: new Date().toISOString(),
        },
        { onConflict: "resident_id" }
      )
      .select()
      .single();

    if (banError) {
      console.error("[ban-guest-pass POST] Upsert error:", banError);
      return NextResponse.json({ error: "Failed to suspend guest pass creation" }, { status: 500 });
    }

    await recordAdminAuditLog(supabase, admin, {
      action: "resident.ban_guest_pass",
      targetType: "resident",
      targetId: residentId,
      metadata: {
        residentName: resident.name,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      },
    });

    return NextResponse.json(
      {
        message: `Guest pass creation suspended for ${resident.name}`,
        ban,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[ban-guest-pass POST] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: ["property_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const { id: residentId } = await params;

  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from("guest_pass_bans")
      .delete()
      .eq("resident_id", residentId);

    if (error) {
      console.error("[ban-guest-pass DELETE] Error:", error);
      return NextResponse.json({ error: "Failed to remove ban" }, { status: 500 });
    }

    await recordAdminAuditLog(supabase, admin, {
      action: "resident.unban_guest_pass",
      targetType: "resident",
      targetId: residentId,
    });

    return NextResponse.json({ message: "Guest pass creation suspension removed successfully" }, { status: 200 });
  } catch (err) {
    console.error("[ban-guest-pass DELETE] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

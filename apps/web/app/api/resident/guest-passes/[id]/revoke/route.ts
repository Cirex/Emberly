import { NextRequest, NextResponse } from "next/server";
import { verifyRequest } from "@/lib/auth";
import { buildGuestPassUrl } from "@/lib/guest-pass-share";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const payload = verifyRequest(request);
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!payload.residentId) {
      return NextResponse.json({ error: "Resident session is missing resident identity" }, { status: 401 });
    }

    const { id } = await params;
    const nowIso = new Date().toISOString();
    const supabase = createAdminClient();

    const { data: pass, error } = await supabase
      .from("guest_passes")
      .update({ status: "revoked" })
      .eq("id", id)
      .eq("resident_id", payload.residentId)
      .eq("status", "active")
      .is("used_at", null)
      .gte("expires_at", nowIso)
      .select("id, share_token, guest_name, guest_email, guest_phone, guest_address, expires_at, used_at, status, created_at")
      .maybeSingle();

    if (error) {
      console.error("[guest-pass revoke] Update error:", error);
      return NextResponse.json({ error: "Failed to revoke guest pass" }, { status: 500 });
    }

    if (!pass) {
      return NextResponse.json(
        { error: "Active guest pass not found", reason: "active_guest_pass_not_found" },
        { status: 404 }
      );
    }

    const { share_token, ...publicPass } = pass;

    return NextResponse.json({
      revoked: true,
      passId: pass.id,
      pass: {
        ...publicPass,
        share_url: buildGuestPassUrl(request.url, share_token),
        status: "revoked",
      },
    });
  } catch (err) {
    console.error("[guest-pass revoke] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

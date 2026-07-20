import { NextRequest, NextResponse } from "next/server";
import { verifyRequest } from "@/lib/auth";
import { sendAndRecordGuestPassEmail } from "@/lib/guest-pass-email";
import { checkRateLimit } from "@/lib/rate-limit";
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
      .select("id, resident_id, share_token, guest_name, guest_email, expires_at, residents(name, unit_id)")
      .eq("id", id)
      .eq("resident_id", payload.residentId)
      .eq("status", "active")
      .is("used_at", null)
      .gte("expires_at", nowIso)
      .maybeSingle();

    if (error) {
      console.error("[guest-pass resend] Query error:", error);
      return NextResponse.json({ error: "Failed to find guest pass" }, { status: 500 });
    }

    if (!pass) {
      return NextResponse.json(
        { error: "Active guest pass not found", reason: "active_guest_pass_not_found" },
        { status: 404 }
      );
    }

    const resident = Array.isArray(pass.residents) ? pass.residents[0] : pass.residents;
    if (!resident) {
      return NextResponse.json({ error: "Resident not found" }, { status: 404 });
    }

    const resendAllowed = await checkRateLimit({
      bucket: `guest-pass-resend:${payload.residentId}:${id}`,
      maxAttempts: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (!resendAllowed) {
      return NextResponse.json(
        { error: "Too many resend attempts. Please try again later." },
        { status: 429 }
      );
    }

    const emailResult = await sendAndRecordGuestPassEmail({
      supabase,
      requestUrl: request.url,
      pass,
      resident,
      logPrefix: "[guest-pass resend]",
    });
    if (!emailResult.sent) {
      return NextResponse.json(
        { error: "Failed to resend guest pass email", reason: "email_delivery_failed" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      resent: true,
      passId: pass.id,
      shareUrl: emailResult.shareUrl,
      expiresAt: pass.expires_at,
    });
  } catch (err) {
    console.error("[guest-pass resend] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

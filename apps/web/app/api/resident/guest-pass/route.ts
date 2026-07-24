import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addHours } from "date-fns";
import { verifyRequest } from "@/lib/auth";
import { buildGuestPassUrl } from "@/lib/guest-pass-share";
import { activeUnitBanForNumber } from "@/lib/guest-pass-unit-bans";
import { sendAndRecordGuestPassEmail } from "@/lib/guest-pass-email";
import {
  createGuestPassShareToken,
} from "@/lib/guest-pass-tokens";
import { checkRateLimit } from "@/lib/rate-limit";
import { getResidentGuestPassEligibility } from "@/lib/residents";
import { createAdminClient } from "@/lib/supabase/admin";

const CreateGuestPassSchema = z.object({
  name: z.string().trim().min(1, "Guest name is required").max(100),
  email: z.string().trim().email("Valid guest email is required"),
  phone: z.string().trim().min(1, "Guest phone is required").max(40),
  address: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const payload = verifyRequest(request);
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!payload.residentId) {
      return NextResponse.json({ error: "Resident session is missing resident identity" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = CreateGuestPassSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Fetch resident
    const { data: resident, error: residentError } = await supabase
      .from("residents")
      .select("id, name, unit_id, access_allowed, access_status, last_resman_verified_at")
      .eq("id", payload.residentId)
      .single();

    if (residentError || !resident) {
      return NextResponse.json({ error: "Resident not found" }, { status: 404 });
    }

    const access = getResidentGuestPassEligibility(resident);
    if (!access.allowed) {
      return NextResponse.json(
        {
          error: "Please verify your ResMan access before creating a guest pass.",
          reason: access.reason,
          resmanStatus: "status" in access ? access.status : null,
        },
        { status: 403 }
      );
    }

    // Check if resident is suspended from creating guest passes
    const { data: ban } = await supabase
      .from("guest_pass_bans")
      .select("id, reason")
      .eq("resident_id", resident.id)
      .maybeSingle();

    if (ban) {
      return NextResponse.json(
        {
          error: "Guest pass creation is suspended for your account",
          reason: ban.reason ?? "Contact your property manager for details",
        },
        { status: 403 }
      );
    }

    // Unit-level suspension: keyed to the ResMan unit (by number, the only
    // bridge residents.unit_id has), so it applies whether or not anyone at
    // the unit ever registered a login.
    const unitNumber = (resident.unit_id ?? "").trim();
    if (unitNumber) {
      // Evaluates the suspension's expiry rule rather than trusting the row's
      // presence, so one that lapsed at move-out stops refusing passes the
      // moment it lapses, not whenever a purge next runs.
      const unitBan = await activeUnitBanForNumber(supabase, unitNumber);

      if (unitBan) {
        return NextResponse.json(
          {
            error: "Guest pass creation is suspended for your unit",
            reason: unitBan.reason ?? "Contact your property manager for details",
          },
          { status: 403 }
        );
      }
    }

    const normalizedGuestEmail = parsed.data.email.toLowerCase();
    const nowIso = new Date().toISOString();
    const { data: existingActivePass, error: existingPassError } = await supabase
      .from("guest_passes")
      .select("id, share_token, guest_name, guest_email, expires_at")
      .eq("resident_id", resident.id)
      .eq("guest_email", normalizedGuestEmail)
      .eq("status", "active")
      .is("used_at", null)
      .gte("expires_at", nowIso)
      .maybeSingle();

    if (existingPassError) {
      console.error("[guest-pass POST] Existing pass lookup error:", existingPassError);
      return NextResponse.json({ error: "Failed to check existing guest passes" }, { status: 500 });
    }

    if (existingActivePass) {
      return NextResponse.json(
        {
          error: "An active guest pass already exists for this guest email.",
          reason: "active_guest_pass_exists",
          existingPassId: existingActivePass.id,
          expiresAt: existingActivePass.expires_at,
          shareUrl: buildGuestPassUrl(request.url, existingActivePass.share_token),
        },
        { status: 409 }
      );
    }

    const creationAllowed = await checkRateLimit({
      bucket: `guest-pass-create:${resident.id}`,
      maxAttempts: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!creationAllowed) {
      return NextResponse.json(
        { error: "Too many guest passes created. Please try again later." },
        { status: 429 }
      );
    }

    const shareToken = createGuestPassShareToken();
    const expiresAt = addHours(new Date(), 24);

    // Persist guest pass
    const { data: guestPass, error: insertError } = await supabase
      .from("guest_passes")
      .insert({
        resident_id: resident.id,
        guest_name: parsed.data.name,
        guest_email: normalizedGuestEmail,
        guest_phone: parsed.data.phone,
        guest_address: parsed.data.address ?? null,
        share_token: shareToken,
        expires_at: expiresAt.toISOString(),
      })
      .select("id, share_token, guest_name, guest_email, guest_phone, guest_address, expires_at, used_at, status, created_at")
      .single();

    if (insertError || !guestPass) {
      console.error("[guest-pass POST] Insert error:", insertError);
      return NextResponse.json({ error: "Failed to create guest pass" }, { status: 500 });
    }

    // Post-insert duplicate sweep: expired passes keep status='active' with a
    // past expires_at, so a partial unique index cannot enforce a single active
    // pass per guest email. Concurrent creations that slip past the pre-insert
    // check are resolved here by keeping the oldest pass and revoking ours.
    const { data: duplicatePasses, error: duplicateSweepError } = await supabase
      .from("guest_passes")
      .select("id, share_token, expires_at")
      .eq("resident_id", resident.id)
      .eq("guest_email", normalizedGuestEmail)
      .eq("status", "active")
      .is("used_at", null)
      .gte("expires_at", nowIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (duplicateSweepError) {
      console.error("[guest-pass POST] Duplicate sweep error:", duplicateSweepError);
    } else {
      const survivor = (duplicatePasses ?? [])[0];
      if (survivor && survivor.id !== guestPass.id) {
        const { error: revokeError } = await supabase
          .from("guest_passes")
          .update({ status: "revoked" })
          .eq("id", guestPass.id);
        if (revokeError) {
          console.error("[guest-pass POST] Failed to revoke duplicate pass:", revokeError);
        }

        return NextResponse.json(
          {
            error: "An active guest pass already exists for this guest email.",
            reason: "active_guest_pass_exists",
            existingPassId: survivor.id,
            expiresAt: survivor.expires_at,
            shareUrl: buildGuestPassUrl(request.url, survivor.share_token),
          },
          { status: 409 }
        );
      }
    }

    const shareUrl = buildGuestPassUrl(request.url, guestPass.share_token);

    // Send email to guest (non-blocking on error — pass is still created)
    const emailResult = await sendAndRecordGuestPassEmail({
      supabase,
      requestUrl: request.url,
      pass: guestPass,
      resident,
      logPrefix: "[guest-pass POST]",
    });
    if (!emailResult.sent) {
      // The pass was created; return success with a warning
      return NextResponse.json(
        {
          passId: guestPass.id,
          qrData: shareUrl,
          shareUrl,
          expiresAt: guestPass.expires_at,
          pass: { ...guestPass, share_url: shareUrl, share_token: undefined },
          warning: "Guest pass created but email delivery failed",
        },
        { status: 201 }
      );
    }

    return NextResponse.json(
      {
        passId: guestPass.id,
        qrData: shareUrl,
        shareUrl,
        expiresAt: guestPass.expires_at,
        pass: { ...guestPass, share_url: shareUrl, share_token: undefined },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[guest-pass POST] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

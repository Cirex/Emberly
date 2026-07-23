import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RESIDENT_ACCESS_STALE_REASON } from "@emberly/core";
import { verifyGuestEntryToken, verifyResidentEntryToken } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import {
  authenticateScanner,
  touchScannerLastSeen,
  rateLimitScannerAttempt,
} from "@/lib/scanner-auth";
import { isResidentAccessFresh } from "@/lib/residents";
import { checkRateLimit } from "@/lib/rate-limit";
import { EMBERLY_PROPERTY_NAME } from "@/lib/property";
import { classifyVerifyPassToken } from "@/lib/verify-pass-tokens";

const VerifySchema = z.object({
  token: z.string().min(1, "Token is required").max(512),
  scannerId: z.string().min(1).max(100).optional(),
});

interface VerifyResponse {
  valid: boolean;
  tenantName?: string;
  unitAddress?: string;
  propertyName?: string;
  vehicles?: Array<{ make: string; model: string; color: string; plate: string }>;
  entryType?: "resident" | "guest";
  entryLogId?: string;
  reason?: string;
  reasonCode?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = VerifySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json<VerifyResponse>(
        { valid: false, reason: "Invalid request format", reasonCode: "invalid_request" },
        { status: 400 }
      );
    }

    const { token, scannerId } = parsed.data;
    const supabase = createAdminClient();
    const authenticatedScanner = await authenticateScanner(
      request,
      scannerId,
      supabase as unknown as UntypedSupabase
    );
    if (!authenticatedScanner) {
      return NextResponse.json<VerifyResponse>(
        { valid: false, reason: "Scanner authentication required", reasonCode: "scanner_auth_required" },
        { status: 401 }
      );
    }

    const { type, parsed: tokenValue } = classifyVerifyPassToken(token);
    const rateLimitKey = type === "resident-entry"
      ? `${authenticatedScanner.scannerId}:resident-entry:${tokenValue.slice(-24)}`
      : type === "guest-entry"
        ? `${authenticatedScanner.scannerId}:guest-entry:${tokenValue.slice(-24)}`
        : type === "guest-share"
          ? `${authenticatedScanner.scannerId}:guest-share:${tokenValue.slice(-24)}`
          : `${authenticatedScanner.scannerId}:unknown:${tokenValue.slice(0, 24)}`;
    const attemptAllowed = await checkRateLimit({
      bucket: `scanner:${rateLimitKey}`,
      maxAttempts: 60,
      windowMs: 60_000,
      failClosed: true,
    });
    if (!attemptAllowed || !rateLimitScannerAttempt(rateLimitKey)) {
      return NextResponse.json<VerifyResponse>(
        { valid: false, reason: "Too many verification attempts", reasonCode: "rate_limited" },
        { status: 429 }
      );
    }

    // Heartbeat only — authentication already confirmed the scanner is enabled.
    await touchScannerLastSeen(supabase as unknown as UntypedSupabase, authenticatedScanner);

    if (type === "guest-entry") {
      return await handleGuestEntryToken(tokenValue, authenticatedScanner.scannerId, supabase);
    } else if (type === "guest-share") {
      return await handleGuestShareToken(tokenValue, authenticatedScanner.scannerId, supabase);
    } else if (type === "resident-entry") {
      return await handleResidentEntryToken(tokenValue, authenticatedScanner.scannerId, supabase);
    }

    return NextResponse.json<VerifyResponse>(
      { valid: false, reason: "Unsupported QR code", reasonCode: "unsupported_qr" },
      { status: 410 }
    );
  } catch (err) {
    console.error("[verify-pass] Unexpected error:", err);
    return NextResponse.json<VerifyResponse>(
      { valid: false, reason: "Internal server error", reasonCode: "server_error" },
      { status: 500 }
    );
  }
}

async function recordAdminAlert(
  supabase: ReturnType<typeof createAdminClient>,
  alert: {
    alert_type: "guest_pass_denied" | "security_scan_denied";
    severity: "warning" | "critical";
    subject_type: "resident" | "guest_pass" | "system";
    subject_id: string;
    title: string;
    detail: string;
    metadata: Record<string, string | null>;
  }
) {
  const untypedSupabase = supabase as unknown as UntypedSupabase;
  const { data: existing } = await untypedSupabase
    .from("admin_alerts")
    .select("id")
    .eq("status", "open")
    .eq("alert_type", alert.alert_type)
    .eq("subject_type", alert.subject_type)
    .eq("subject_id", alert.subject_id)
    .maybeSingle();

  if (existing?.id) {
    await untypedSupabase
      .from("admin_alerts")
      .update({
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        metadata: alert.metadata,
      })
      .eq("id", existing.id);
    return;
  }

  await untypedSupabase.from("admin_alerts").insert({
    ...alert,
    status: "open",
  });
}

async function handleGuestEntryToken(
  token: string,
  scannerId: string | undefined,
  supabase: ReturnType<typeof createAdminClient>
): Promise<NextResponse<VerifyResponse>> {
  const entry = verifyGuestEntryToken(token);
  if (!entry) {
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "Invalid or expired code",
      reasonCode: "invalid_or_expired_code",
    });
  }

  const { data: pass, error } = await supabase
    .from("guest_passes")
    .select(
      "id, guest_name, resident_id, expires_at, used_at, status, residents(name, unit_id)"
    )
    .eq("id", entry.guestPassId)
    .maybeSingle();

  if (error) {
    console.error("[verify-pass] Guest entry pass query error:", error);
    return NextResponse.json<VerifyResponse>({ valid: false, reason: "Verification error", reasonCode: "verification_error" });
  }

  if (!pass) {
    await recordAdminAlert(supabase, {
      alert_type: "guest_pass_denied",
      severity: "warning",
      subject_type: "system",
      subject_id: `unknown-guest-entry-${entry.guestPassId}`,
      title: "Unknown guest entry QR scanned",
      detail: "A scanner attempted to verify a signed guest entry token for a pass that does not exist.",
      metadata: { scannerId: scannerId ?? null },
    });
    return NextResponse.json<VerifyResponse>({ valid: false, reason: "Pass not found", reasonCode: "pass_not_found" });
  }

  return verifyGuestPassRecord(pass, scannerId, supabase);
}

async function handleGuestShareToken(
  shareToken: string,
  scannerId: string | undefined,
  supabase: ReturnType<typeof createAdminClient>
): Promise<NextResponse<VerifyResponse>> {
  const { data: pass, error } = await supabase
    .from("guest_passes")
    .select(
      "id, guest_name, resident_id, expires_at, used_at, status, residents(name, unit_id)"
    )
    .eq("share_token", shareToken)
    .maybeSingle();

  if (error) {
    console.error("[verify-pass] Guest share pass query error:", error);
    return NextResponse.json<VerifyResponse>({ valid: false, reason: "Verification error", reasonCode: "verification_error" });
  }

  if (!pass) {
    await recordAdminAlert(supabase, {
      alert_type: "guest_pass_denied",
      severity: "warning",
      subject_type: "system",
      subject_id: `unknown-guest-share-${shareToken.slice(0, 12)}`,
      title: "Unknown guest pass QR scanned",
      detail: "A scanner attempted to verify a guest pass share QR that does not match any active record.",
      metadata: { scannerId: scannerId ?? null },
    });
    return NextResponse.json<VerifyResponse>({ valid: false, reason: "Pass not found", reasonCode: "pass_not_found" });
  }

  return verifyGuestPassRecord(pass, scannerId, supabase);
}

/** The guest_passes row (+ embedded resident) the verify path decides on. Typed
 *  so the access-control logic below is checked against real column names rather
 *  than an opaque `any`. */
interface GuestPassRecord {
  id: string;
  guest_name: string;
  resident_id: string;
  expires_at: string;
  used_at: string | null;
  status: string;
  residents: { name: string; unit_id: string } | Array<{ name: string; unit_id: string }> | null;
}

async function verifyGuestPassRecord(
  pass: GuestPassRecord,
  scannerId: string | undefined,
  supabase: ReturnType<typeof createAdminClient>
): Promise<NextResponse<VerifyResponse>> {
  if (pass.status === "revoked") {
    await recordAdminAlert(supabase, {
      alert_type: "guest_pass_denied",
      severity: "critical",
      subject_type: "guest_pass",
      subject_id: pass.id,
      title: "Revoked guest pass scanned",
      detail: `${pass.guest_name}'s revoked guest pass was scanned.`,
      metadata: { scannerId: scannerId ?? null, guestName: pass.guest_name },
    });
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "This guest pass has been revoked",
      reasonCode: "guest_pass_revoked",
    });
  }

  if (pass.used_at) {
    await recordAdminAlert(supabase, {
      alert_type: "guest_pass_denied",
      severity: "warning",
      subject_type: "guest_pass",
      subject_id: pass.id,
      title: "Used guest pass scanned again",
      detail: `${pass.guest_name}'s guest pass was scanned after it had already been used.`,
      metadata: { scannerId: scannerId ?? null, guestName: pass.guest_name },
    });
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "This pass has already been used",
      reasonCode: "guest_pass_used",
    });
  }

  const usedAt = new Date().toISOString();

  if (new Date(pass.expires_at) < new Date(usedAt)) {
    await recordAdminAlert(supabase, {
      alert_type: "guest_pass_denied",
      severity: "warning",
      subject_type: "guest_pass",
      subject_id: pass.id,
      title: "Expired guest pass scanned",
      detail: `${pass.guest_name}'s expired guest pass was scanned.`,
      metadata: { scannerId: scannerId ?? null, guestName: pass.guest_name },
    });
    return NextResponse.json<VerifyResponse>({ valid: false, reason: "This pass has expired", reasonCode: "guest_pass_expired" });
  }

  const resident = Array.isArray(pass.residents) ? pass.residents[0] : pass.residents;
  if (!resident) {
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "Associated resident not found",
      reasonCode: "resident_not_found",
    });
  }

  // Unit-level suspension applies at the gate too: a pass issued before the
  // unit's guest visits were disabled must not still open the door.
  const passUnitNumber = (resident.unit_id ?? "").trim();
  if (passUnitNumber) {
    const { data: unitBan } = await supabase
      .from("guest_pass_unit_bans")
      .select("resman_unit_id")
      .eq("unit_number", passUnitNumber)
      .limit(1)
      .maybeSingle();

    if (unitBan) {
      await recordAdminAlert(supabase, {
        alert_type: "guest_pass_denied",
        severity: "critical",
        subject_type: "guest_pass",
        subject_id: pass.id,
        title: "Guest pass scanned for a suspended unit",
        detail: `${pass.guest_name}'s guest pass was scanned, but guest visits are suspended for unit ${passUnitNumber}.`,
        metadata: { scannerId: scannerId ?? null, guestName: pass.guest_name, unitNumber: passUnitNumber },
      });
      return NextResponse.json<VerifyResponse>({
        valid: false,
        reason: "Guest visits are suspended for this unit",
        reasonCode: "unit_guests_suspended",
      });
    }
  }

  const { data: updatedPass, error: updateError } = await supabase
    .from("guest_passes")
    .update({ used_at: usedAt, status: "used" })
    .eq("id", pass.id)
    .is("used_at", null)
    .eq("status", "active")
    .gte("expires_at", usedAt)
    .select("id")
    .maybeSingle();

  if (updateError || !updatedPass) {
    console.error("[verify-pass] Failed to mark pass as used:", updateError);
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "This pass has already been used or expired",
      reasonCode: "guest_pass_consumed",
    });
  }

  const { data: guestEntryLog, error: entryLogError } = await supabase.from("entry_logs").insert({
    resident_id: pass.resident_id,
    guest_pass_id: pass.id,
    entry_type: "guest",
    tenant_name: pass.guest_name,
    unit_address: resident.unit_id,
    property_name: EMBERLY_PROPERTY_NAME,
    scanner_id: scannerId ?? null,
  }).select("id").single();

  if (entryLogError || !guestEntryLog) {
    console.error("[verify-pass] Failed to record guest entry log:", entryLogError);
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "Entry log could not be recorded",
      reasonCode: "entry_log_failed",
    });
  }

  return NextResponse.json<VerifyResponse>({
    valid: true,
    tenantName: pass.guest_name,
    unitAddress: resident.unit_id,
    propertyName: EMBERLY_PROPERTY_NAME,
    entryType: "guest",
    entryLogId: guestEntryLog.id,
    vehicles: [],
  });
}

async function handleResidentEntryToken(
  token: string,
  scannerId: string | undefined,
  supabase: ReturnType<typeof createAdminClient>
): Promise<NextResponse<VerifyResponse>> {
  const entry = verifyResidentEntryToken(token);
  if (!entry) {
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "Invalid or expired code",
      reasonCode: "invalid_or_expired_code",
    });
  }

  const { data: resident, error } = await supabase
    .from("residents")
    .select("id, name, unit_id, access_allowed, access_status, last_resman_verified_at")
    .eq("id", entry.residentId)
    .single();

  if (error || !resident) {
    return NextResponse.json<VerifyResponse>({ valid: false, reason: "Resident not found", reasonCode: "resident_not_found" });
  }

  if (!isResidentAccessFresh(resident)) {
    await recordAdminAlert(supabase, {
      alert_type: "security_scan_denied",
      severity: resident.access_allowed === false ? "critical" : "warning",
      subject_type: "resident",
      subject_id: resident.id,
      title: "Resident scan denied",
      detail: resident.access_allowed === false
        ? `${resident.name} is not currently allowed access.`
        : `${resident.name}'s access heartbeat is stale.`,
      metadata: { scannerId: scannerId ?? null, residentName: resident.name },
    });
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: resident.access_allowed === false
        ? "Resident is not currently allowed access"
        : "Resident access needs to be refreshed",
      reasonCode: resident.access_allowed === false ? "resident_access_denied" : RESIDENT_ACCESS_STALE_REASON,
    });
  }

  // Consume the token's jti before granting: the resident QR is single-use
  // within its 60s TTL, so a screenshot/replay of the same code is rejected.
  // Atomic — the primary-key conflict IS the replay signal. Any other insert
  // error fails closed (no access) rather than risking a double-grant.
  const { error: consumeError } = await (supabase as unknown as UntypedSupabase)
    .from("resident_entry_token_uses")
    .insert({
      jti: entry.jti,
      resident_id: resident.id,
      expires_at: new Date(entry.exp).toISOString(),
    });
  if (consumeError) {
    if ((consumeError as { code?: string }).code === "23505") {
      return NextResponse.json<VerifyResponse>({
        valid: false,
        reason: "This code has already been used",
        reasonCode: "resident_entry_replayed",
      });
    }
    console.error("[verify-pass] Failed to consume resident entry token:", consumeError);
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "Entry could not be verified",
      reasonCode: "verification_error",
    });
  }

  const { data: residentEntryLog, error: entryLogError } = await supabase.from("entry_logs").insert({
    resident_id: resident.id,
    entry_type: "resident",
    tenant_name: resident.name,
    unit_address: resident.unit_id,
    property_name: EMBERLY_PROPERTY_NAME,
    scanner_id: scannerId ?? null,
    notes: entry.deviceId ? `resident-entry device ${entry.deviceId}` : "resident-entry",
  }).select("id").single();

  if (entryLogError || !residentEntryLog) {
    console.error("[verify-pass] Failed to record resident entry log:", entryLogError);
    return NextResponse.json<VerifyResponse>({
      valid: false,
      reason: "Entry log could not be recorded",
      reasonCode: "entry_log_failed",
    });
  }

  return NextResponse.json<VerifyResponse>({
    valid: true,
    tenantName: resident.name,
    unitAddress: resident.unit_id,
    propertyName: EMBERLY_PROPERTY_NAME,
    entryType: "resident",
    entryLogId: residentEntryLog.id,
    // The iOS scanner app decodes an optional `vehicles` array; the vehicles
    // table was removed with the legacy batch sync, so this is always empty.
    vehicles: [],
  });
}

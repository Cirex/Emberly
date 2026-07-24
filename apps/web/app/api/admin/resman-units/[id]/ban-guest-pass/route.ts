import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { recordAdminAuditLog } from "@/lib/admin-audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveExpiry, unitContext } from "@/lib/unit-expiry";

/**
 * Unit-level guest-pass suspension, keyed to the ResMan unit.
 *
 * The resident-level ban (/api/admin/residents/[id]/ban-guest-pass) only works
 * once a tenant has registered a login; this one covers every unit regardless
 * of enrollment. Enforced at pass creation, at the gate (verify-pass), and
 * surfaced as "Guests allowed: No" on the unit detail and the guard app.
 */

/**
 * Expiry mirrors unit tags exactly (lib/unit-expiry.ts). `move_out` is the one
 * that matters most: the "NO GUESTS ALLOWED" tag that usually prompts a
 * suspension expires with the lease, and a suspension that outlived it would
 * silently punish the next household.
 */
const SuspensionSchema = z.object({
  reason: z.string().max(500).optional(),
  expiryKind: z.enum(["never", "date", "duration", "move_out", "status_change"]).optional().default("never"),
  expiresOn: z.string().trim().optional().nullable(),
  durationDays: z.number().int().positive().max(3650).optional().nullable(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: ["property_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const { id: unitId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = SuspensionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // The unit must exist in the mirror, and its number is what the
    // first-party side (residents.unit_id) enforces by.
    const { data: unit, error: unitError } = await supabase
      .from("resman_units")
      .select("resman_unit_id, number")
      .eq("resman_unit_id", unitId)
      .maybeSingle();

    if (unitError || !unit) {
      return NextResponse.json({ error: "Unit not found" }, { status: 404 });
    }
    const unitNumber = (unit.number ?? "").trim();
    if (!unitNumber) {
      return NextResponse.json(
        { error: "Unit has no number — cannot enforce a guest-pass suspension for it" },
        { status: 422 }
      );
    }

    // Conditional rules snapshot the unit's live lease/status, so they need the
    // unit's context. A move_out suspension on a vacant unit has nothing to
    // bind to and is rejected rather than silently stored as permanent.
    let expiry;
    try {
      expiry = resolveExpiry(
        {
          kind: parsed.data.expiryKind,
          expiresOn: parsed.data.expiresOn,
          durationDays: parsed.data.durationDays,
        },
        await unitContext(supabase, unitNumber)
      );
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid expiry rule" },
        { status: 422 }
      );
    }

    const { data: ban, error: banError } = await supabase
      .from("guest_pass_unit_bans")
      .upsert(
        {
          resman_unit_id: unitId,
          unit_number: unitNumber,
          reason: parsed.data.reason ?? null,
          banned_by: admin.displayName,
          banned_at: new Date().toISOString(),
          expiry_kind: parsed.data.expiryKind,
          ...expiry,
        },
        { onConflict: "resman_unit_id" }
      )
      .select()
      .single();

    if (banError) {
      console.error("[unit ban-guest-pass POST] Upsert error:", banError);
      return NextResponse.json({ error: "Failed to suspend guest passes for this unit" }, { status: 500 });
    }

    await recordAdminAuditLog(supabase, admin, {
      action: "unit.ban_guest_pass",
      targetType: "resman_unit",
      targetId: unitId,
      metadata: {
        unitNumber,
        expiryKind: parsed.data.expiryKind,
        ...(expiry.expires_at ? { expiresAt: expiry.expires_at } : {}),
        ...(expiry.bound_lease_id ? { boundLeaseId: expiry.bound_lease_id } : {}),
        ...(expiry.status_trigger ? { statusTrigger: expiry.status_trigger } : {}),
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      },
    });

    return NextResponse.json(
      { message: `Guest passes suspended for unit ${unitNumber}`, ban },
      { status: 200 }
    );
  } catch (err) {
    console.error("[unit ban-guest-pass POST] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: ["property_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const { id: unitId } = await params;

  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from("guest_pass_unit_bans")
      .delete()
      .eq("resman_unit_id", unitId);

    if (error) {
      console.error("[unit ban-guest-pass DELETE] Error:", error);
      return NextResponse.json({ error: "Failed to remove unit suspension" }, { status: 500 });
    }

    await recordAdminAuditLog(supabase, admin, {
      action: "unit.unban_guest_pass",
      targetType: "resman_unit",
      targetId: unitId,
    });

    return NextResponse.json({ message: "Guest-pass suspension removed for this unit" }, { status: 200 });
  } catch (err) {
    console.error("[unit ban-guest-pass DELETE] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

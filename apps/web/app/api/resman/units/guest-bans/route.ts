import { NextResponse } from "next/server";
import { activeUnitBans, BAN_SELECT, purgeExpiredUnitBans } from "@/lib/guest-pass-unit-bans";
import { requireResmanApiKey, tokenForbiddenForResource } from "@/lib/resman-api-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

/**
 * The unit numbers where guest visits are currently disabled — the union of:
 *   - guest_pass_unit_bans (the unit itself is suspended, no enrollment needed)
 *   - guest_pass_bans joined through residents (someone at the unit is blocked)
 *
 * This exists for the guard app's "No Guests" tenant filter: the units list is
 * a generic ResMan-mirror read, while ban state lives in first-party tables, so
 * the app fetches this small set once and filters client-side. Same audience
 * gating as the unit detail pane: scanners and back-office tokens may read it,
 * scoped field-device tokens may not.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "token" && tokenForbiddenForResource(auth.subject, "units", "units/guest-bans")) {
    return NextResponse.json({ error: "Not authorized for this resource" }, { status: 403 });
  }

  try {
    const supabase = createUntypedAdminClient();
    // Sweep suspensions that have come due, so the chip never lists a unit
    // whose ban lifted at move-out. Every reader also cleans up, as tags do.
    await purgeExpiredUnitBans(supabase);

    const [unitBanRes, residentBanRes] = await Promise.all([
      supabase.from("guest_pass_unit_bans").select(BAN_SELECT),
      supabase.from("guest_pass_bans").select("residents(unit_id)"),
    ]);
    if (unitBanRes.error) throw unitBanRes.error;
    if (residentBanRes.error) throw residentBanRes.error;

    const unitNumbers = new Set<string>();
    // Re-evaluated rather than trusted: the purge above races the read, and a
    // conditional rule can come due between them.
    const live = await activeUnitBans(supabase, (unitBanRes.data ?? []) as Record<string, unknown>[]);
    for (const ban of live.values()) {
      const n = ban.unitNumber.trim();
      if (n) unitNumbers.add(n);
    }
    for (const row of (residentBanRes.data ?? []) as Array<{
      residents: { unit_id: string | null } | Array<{ unit_id: string | null }> | null;
    }>) {
      const resident = Array.isArray(row.residents) ? row.residents[0] : row.residents;
      const n = resident?.unit_id?.trim();
      if (n) unitNumbers.add(n);
    }

    return NextResponse.json({ data: { unitNumbers: [...unitNumbers].sort() } });
  } catch (error) {
    console.error("[resman-api units guest-bans] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

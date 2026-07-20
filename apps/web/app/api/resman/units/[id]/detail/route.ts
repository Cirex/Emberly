import { NextResponse } from "next/server";
import { requireResmanApiKey, tokenForbiddenForResource } from "@/lib/resman-api-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

type DetailContext = { params: Promise<{ id: string }> };

/**
 * The per-unit facts the guard app's tenant detail pane needs and the generic
 * unit resource cannot express: vehicles live two joins away, and the last entry
 * lives in a first-party table the ResMan mirror knows nothing about.
 *
 * Vehicles hang off the *lease*: unit.current_lease_id → resman_residents
 * (person-leases on that lease) → resman_lease_vehicles. A vacant unit, or one
 * whose lease has no residents synced, correctly yields none.
 *
 * Last entry is matched on `entry_logs.unit_address`, which is what verify-pass
 * records at scan time. That is a denormalized string rather than a key, so the
 * match is deliberately conservative — see the comment at the query.
 */
export async function GET(request: Request, context: DetailContext): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  // This pane returns resident PII (names, vehicles, guest passes, last entry).
  // Scanners (the guard app) and back-office tokens may read it; a scoped
  // field-device token (e.g. the maintenance app) may not — it gets the map's
  // unit facts from the generic /api/resman/units list, never this detail.
  if (auth.kind === "token" && tokenForbiddenForResource(auth.subject, "units", "units/detail")) {
    return NextResponse.json({ error: "Not authorized for this resource" }, { status: 403 });
  }

  try {
    const { id } = await context.params;
    const supabase = createUntypedAdminClient();

    const { data: unit, error: unitError } = await supabase
      .from("resman_units")
      .select("resman_unit_id, number, current_lease_id")
      .eq("resman_unit_id", id)
      .maybeSingle();

    if (unitError) throw unitError;
    if (!unit) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // The unit's enrolled residents answer two questions (who may host, and
    // whose passes are live), so they're fetched once and shared.
    const residents = await loadResidents(supabase, unit.number as string);

    const [vehicles, lastEntry, guestPasses, guestAccess] = await Promise.all([
      loadVehicles(supabase, unit.current_lease_id as string | null),
      loadLastEntry(supabase, unit.number as string),
      loadActiveGuestPasses(supabase, residents),
      loadGuestAccess(supabase, residents),
    ]);

    return NextResponse.json({ data: { vehicles, lastEntry, guestPasses, guestAccess } });
  } catch (error) {
    console.error("[resman-api units detail] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function loadVehicles(supabase: UntypedSupabase, currentLeaseId: string | null) {
  if (!currentLeaseId) return [];

  // Vehicles reference a person-lease, so resolve the lease's residents first.
  const { data: residents, error: residentsError } = await supabase
    .from("resman_residents")
    .select("resman_person_lease_id")
    .eq("resman_lease_id", currentLeaseId);

  if (residentsError) throw residentsError;
  const personLeaseIds = (residents ?? []).map((r: Record<string, unknown>) => r.resman_person_lease_id as string);
  if (personLeaseIds.length === 0) return [];

  const { data, error } = await supabase
    .from("resman_lease_vehicles")
    .select("resman_vehicle_id, make, model, year, color, license_plate, license_plate_state, parking_spot")
    .in("resman_person_lease_id", personLeaseIds);

  if (error) throw error;

  return (data ?? [])
    .map((v: Record<string, unknown>) => ({
      id: v.resman_vehicle_id as string,
      make: (v.make as string) ?? "",
      model: (v.model as string) ?? "",
      year: (v.year as string) ?? "",
      color: (v.color as string) ?? "",
      licensePlate: (v.license_plate as string) ?? "",
      licensePlateState: (v.license_plate_state as string) ?? "",
      parkingSpot: (v.parking_spot as string) ?? "",
    }))
    // The mirror holds rows with every field blank (empty tab sections, plus
    // stale rows written before the lease-tab extraction was fixed). They would
    // render as a phantom vehicle, so drop anything that can't identify a car.
    .filter((v: { make: string; model: string; licensePlate: string }) => v.make || v.model || v.licensePlate);
}

type Resident = { id: string; name: string; accessAllowed: boolean };

/**
 * The residents enrolled against this unit.
 *
 * The two systems don't share a key: `residents` is our own registry (populated
 * when a resident enrolls), while the unit comes from the ResMan mirror. The only
 * bridge is `residents.unit_id`, a denormalized string, so this matches the unit
 * number exactly — the same conservative join as the entry log, for the same
 * reason: a loose match would attribute a neighbour's people to this door.
 */
async function loadResidents(supabase: UntypedSupabase, unitNumber: string): Promise<Resident[]> {
  const trimmed = unitNumber?.trim();
  if (!trimmed) return [];

  const { data, error } = await supabase
    .from("residents")
    .select("id, name, access_allowed")
    .eq("unit_id", trimmed);

  if (error) throw error;

  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    name: (r.name as string) ?? "",
    accessAllowed: Boolean(r.access_allowed),
  }));
}

/**
 * Whether this unit's residents may have guests at all.
 *
 * The counts are the raw facts; the guard app collapses them to Yes/No (see
 * `guestsAllowedLabel`), where guests are allowed unless an admin has
 * explicitly banned someone at this unit from issuing passes (`guest_pass_bans`).
 */
async function loadGuestAccess(supabase: UntypedSupabase, residents: Resident[]) {
  if (residents.length === 0) return { residents: 0, allowed: 0, banned: 0 };

  const { data, error } = await supabase
    .from("guest_pass_bans")
    .select("resident_id")
    .in(
      "resident_id",
      residents.map((r) => r.id),
    );

  if (error) throw error;

  const banned = new Set((data ?? []).map((b: Record<string, unknown>) => b.resident_id as string));
  return {
    residents: residents.length,
    allowed: residents.filter((r) => r.accessAllowed && !banned.has(r.id)).length,
    banned: banned.size,
  };
}

/**
 * Active guest passes for whoever lives in this unit.
 *
 * "Active" means both flags: the pass hasn't been revoked/used AND hasn't run
 * past its 24h expiry. Status alone would list expired passes as live.
 */
async function loadActiveGuestPasses(supabase: UntypedSupabase, residents: Resident[]) {
  if (residents.length === 0) return [];
  const byId = new Map(residents.map((r) => [r.id, r.name]));

  const { data, error } = await supabase
    .from("guest_passes")
    .select("id, resident_id, guest_name, expires_at, created_at")
    .in("resident_id", [...byId.keys()])
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((p: Record<string, unknown>) => ({
    id: p.id as string,
    guestName: (p.guest_name as string) ?? "",
    hostName: byId.get(p.resident_id as string) ?? "",
    expiresAt: p.expires_at as string,
    createdAt: (p.created_at as string) ?? null,
  }));
}

async function loadLastEntry(supabase: UntypedSupabase, unitNumber: string) {
  // `entry_logs.unit_address` is whatever verify-pass recorded for the resident,
  // not a foreign key to resman_units. An exact match on the unit number is the
  // only claim that can be made safely: a fuzzy match would attribute a
  // neighbour's entry to this unit, which is worse than reporting none.
  const trimmed = unitNumber?.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase
    .from("entry_logs")
    .select("id, entry_type, tenant_name, entered_at")
    .eq("unit_address", trimmed)
    .order("entered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id as string,
    entryType: data.entry_type as "resident" | "guest",
    tenantName: (data.tenant_name as string) ?? "",
    enteredAt: data.entered_at as string | null,
  };
}

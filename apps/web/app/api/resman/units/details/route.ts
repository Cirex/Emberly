import { NextResponse } from "next/server";
import { activeUnitBans, BAN_SELECT } from "@/lib/guest-pass-unit-bans";
import { requireResmanApiKey, tokenForbiddenForResource } from "@/lib/resman-api-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Every unit's detail pane in one response.
 *
 * The per-unit sibling (`units/[id]/detail`) costs ~6 round trips, so a guard
 * tapping down a list pays a spinner per unit — most visibly on vehicles, which
 * sit two joins from the unit. This route answers the same questions for the
 * whole property in a fixed number of grouped queries, so the app can cache the
 * lot on sync and render taps instantly.
 *
 * The shape per unit is identical to the per-unit route, so the client can use
 * one parser and treat a cached entry and a fresh fetch interchangeably.
 */

/**
 * Last-entry is the one fact with no bounded per-unit key to group on, so it's
 * read as a single ordered scan and reduced to the newest row per unit. The cap
 * bounds that scan; a unit whose last entry is older than the cap reports none
 * here, and the client's background per-unit refresh fills it in on select.
 */
const ENTRY_SCAN_LIMIT = 20_000;

/** PostgREST caps a response at 1000 rows by default, so every read here pages. */
const PAGE = 1000;

type Row = Record<string, unknown>;
type Tune = (q: ReturnType<ReturnType<UntypedSupabase["from"]>["select"]>) => typeof q;

/**
 * Read a whole table, paged.
 *
 * These are all property-sized (units, leases, vehicles), so pulling them whole
 * and joining in memory costs a handful of round trips. The alternative — an
 * `.in()` per parent id — puts every lease uuid in the query string and trips
 * "URI too long" well before the property does.
 */
async function selectAll(
  supabase: UntypedSupabase,
  table: string,
  columns: string,
  tune?: Tune,
  cap = Number.POSITIVE_INFINITY,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const size = Math.min(PAGE, cap - from);
    let query = supabase.from(table).select(columns);
    if (tune) query = tune(query);
    const { data, error } = await query.range(from, from + size - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  // Same PII gate as the per-unit route: scanners and back-office tokens may
  // read it, a scoped field-device token may not.
  if (auth.kind === "token" && tokenForbiddenForResource(auth.subject, "units", "units/detail")) {
    return NextResponse.json({ error: "Not authorized for this resource" }, { status: 403 });
  }

  try {
    const supabase = createUntypedAdminClient();

    const units = await selectAll(supabase, "resman_units", "resman_unit_id, number, current_lease_id");

    // ── Residents (our own registry), grouped by the unit number they enrolled
    // against. Same conservative exact match as the per-unit route.
    const residentRows = await selectAll(supabase, "residents", "id, name, access_allowed, unit_id");
    const residentsByUnit = new Map<string, Resident[]>();
    for (const r of residentRows) {
      const unitNumber = ((r.unit_id as string) ?? "").trim();
      if (!unitNumber) continue;
      push(residentsByUnit, unitNumber, {
        id: r.id as string,
        name: (r.name as string) ?? "",
        accessAllowed: Boolean(r.access_allowed),
      });
    }

    // ── Vehicles: unit → current lease → person-leases → vehicles.
    const personLeaseRows = await selectAll(
      supabase,
      "resman_residents",
      "resman_lease_id, resman_person_lease_id",
    );
    const personLeasesByLease = new Map<string, string[]>();
    for (const row of personLeaseRows) {
      push(personLeasesByLease, row.resman_lease_id as string, row.resman_person_lease_id as string);
    }

    const vehicleRows = await selectAll(
      supabase,
      "resman_lease_vehicles",
      "resman_person_lease_id, resman_vehicle_id, make, model, year, color, license_plate, license_plate_state, parking_spot",
    );
    const vehiclesByPersonLease = new Map<string, Vehicle[]>();
    for (const v of vehicleRows) {
      const vehicle: Vehicle = {
        id: v.resman_vehicle_id as string,
        make: (v.make as string) ?? "",
        model: (v.model as string) ?? "",
        year: (v.year as string) ?? "",
        color: (v.color as string) ?? "",
        licensePlate: (v.license_plate as string) ?? "",
        licensePlateState: (v.license_plate_state as string) ?? "",
        parkingSpot: (v.parking_spot as string) ?? "",
      };
      // Blank rows would render as a phantom car — same filter as the per-unit route.
      if (!vehicle.make && !vehicle.model && !vehicle.licensePlate) continue;
      push(vehiclesByPersonLease, v.resman_person_lease_id as string, vehicle);
    }

    // ── Guest access: unit-level suspensions and per-resident bans. The
    // suspensions are rule-evaluated (a move_out ban lifts with its lease), so
    // this pane agrees with the gate rather than reporting a lapsed ban.
    const unitBanRows = await selectAll(supabase, "guest_pass_unit_bans", BAN_SELECT);
    const unitBanned = new Set((await activeUnitBans(supabase, unitBanRows)).keys());

    const banRows = await selectAll(supabase, "guest_pass_bans", "resident_id");
    const bannedResidents = new Set(banRows.map((b) => b.resident_id as string));

    // ── Active guest passes, grouped by the resident who issued them.
    const nowIso = new Date().toISOString();
    const passRows = await selectAll(
      supabase,
      "guest_passes",
      "id, resident_id, guest_name, expires_at, created_at",
      (q) => q.eq("status", "active").gt("expires_at", nowIso).order("expires_at", { ascending: true }),
    );
    const passesByResident = new Map<string, Row[]>();
    for (const p of passRows) {
      push(passesByResident, p.resident_id as string, p);
    }

    // ── Last entry per unit, from one ordered scan (see ENTRY_SCAN_LIMIT).
    const entryRows = await selectAll(
      supabase,
      "entry_logs",
      "id, entry_type, tenant_name, entered_at, unit_address",
      (q) => q.order("entered_at", { ascending: false }),
      ENTRY_SCAN_LIMIT,
    );
    const lastEntryByUnit = new Map<string, LastEntry>();
    for (const e of entryRows) {
      const unitNumber = ((e.unit_address as string) ?? "").trim();
      if (!unitNumber || lastEntryByUnit.has(unitNumber)) continue; // rows are newest-first
      lastEntryByUnit.set(unitNumber, {
        id: e.id as string,
        entryType: e.entry_type as "resident" | "guest",
        tenantName: (e.tenant_name as string) ?? "",
        enteredAt: (e.entered_at as string) ?? null,
      });
    }

    // ── Assemble, keyed the way the client selects: by resman_unit_id.
    const data: Record<string, UnitDetail> = {};
    for (const unit of units) {
      const unitId = unit.resman_unit_id as string;
      const unitNumber = ((unit.number as string) ?? "").trim();
      const leaseId = unit.current_lease_id as string | null;
      const residents = residentsByUnit.get(unitNumber) ?? [];

      const vehicles: Vehicle[] = [];
      if (leaseId) {
        for (const personLeaseId of personLeasesByLease.get(leaseId) ?? []) {
          vehicles.push(...(vehiclesByPersonLease.get(personLeaseId) ?? []));
        }
      }

      const nameById = new Map(residents.map((r) => [r.id, r.name]));
      const guestPasses = residents
        .flatMap((r) => passesByResident.get(r.id) ?? [])
        .map((p) => ({
          id: p.id as string,
          guestName: (p.guest_name as string) ?? "",
          hostName: nameById.get(p.resident_id as string) ?? "",
          expiresAt: p.expires_at as string,
          createdAt: (p.created_at as string) ?? null,
        }));

      const suspended = unitBanned.has(unitId);
      const banned = residents.filter((r) => bannedResidents.has(r.id)).length;

      data[unitId] = {
        vehicles,
        lastEntry: lastEntryByUnit.get(unitNumber) ?? null,
        guestPasses,
        guestAccess: {
          residents: residents.length,
          allowed: suspended
            ? 0
            : residents.filter((r) => r.accessAllowed && !bannedResidents.has(r.id)).length,
          banned,
          unitBanned: suspended,
        },
      };
    }

    return NextResponse.json({ data });
  } catch (error) {
    console.error("[resman-api units details] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

type Resident = { id: string; name: string; accessAllowed: boolean };
type Vehicle = {
  id: string;
  make: string;
  model: string;
  year: string;
  color: string;
  licensePlate: string;
  licensePlateState: string;
  parkingSpot: string;
};
type LastEntry = {
  id: string;
  entryType: "resident" | "guest";
  tenantName: string;
  enteredAt: string | null;
};
type UnitDetail = {
  vehicles: Vehicle[];
  lastEntry: LastEntry | null;
  guestPasses: { id: string; guestName: string; hostName: string; expiresAt: string; createdAt: string | null }[];
  guestAccess: { residents: number; allowed: number; banned: number; unitBanned: boolean };
};

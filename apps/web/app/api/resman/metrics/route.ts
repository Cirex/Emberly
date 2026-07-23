import { NextResponse } from "next/server";
import { requireResmanApiKey, tokenForbiddenForResource } from "@/lib/resman-api-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import { startOfPropertyDay } from "@/lib/property-time";

/**
 * Property-wide headline counts for the guard app's tenant dashboard, in one
 * round-trip so the metric cards never fan out per-card requests:
 *   - entriesToday / entriesGuestsToday — entry_logs since property-local
 *     midnight (a running pulse of gate activity).
 *   - vehicleCount — vehicles on file, counting only identifiable rows (the
 *     mirror keeps blank placeholder rows the detail pane also drops).
 *
 * Same audience gating as the other bespoke scanner reads: scanners and
 * back-office tokens may read it, scoped field-device tokens may not.
 */

const VEHICLE_PAGE = 1000;
const VEHICLE_CAP = 20_000; // safety valve, far above one property's fleet

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "token" && tokenForbiddenForResource(auth.subject, "units", "units/metrics")) {
    return NextResponse.json({ error: "Not authorized for this resource" }, { status: 403 });
  }

  try {
    const supabase = createUntypedAdminClient();
    const todayStart = startOfPropertyDay(new Date()).toISOString();

    const [entriesTotal, entriesGuests, vehicleCount] = await Promise.all([
      // head:true COUNT, never a fetched-and-filtered array — the latter caps at
      // PostgREST's ~1000-row default and would under-count a busy day.
      supabase.from("entry_logs").select("id", { count: "exact", head: true }).gte("entered_at", todayStart),
      supabase
        .from("entry_logs")
        .select("id", { count: "exact", head: true })
        .gte("entered_at", todayStart)
        .eq("entry_type", "guest"),
      countIdentifiableVehicles(supabase),
    ]);

    if (entriesTotal.error) throw entriesTotal.error;
    if (entriesGuests.error) throw entriesGuests.error;

    return NextResponse.json({
      data: {
        entriesToday: entriesTotal.count ?? 0,
        entriesGuestsToday: entriesGuests.count ?? 0,
        vehicleCount,
      },
    });
  } catch (error) {
    console.error("[resman-api metrics] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Vehicles on file, excluding the mirror's blank placeholder rows (empty tab
 * sections, plus stale rows written before the lease-tab extraction was fixed)
 * — the same "identifiable" rule the unit-detail pane applies, so the headline
 * count matches what a guard sees when they open a unit. Paged past the
 * ~1000-row default so the count is complete.
 */
async function countIdentifiableVehicles(supabase: UntypedSupabase): Promise<number> {
  let count = 0;
  for (let offset = 0; offset < VEHICLE_CAP; offset += VEHICLE_PAGE) {
    const { data, error } = await supabase
      .from("resman_lease_vehicles")
      .select("make, model, license_plate")
      .order("resman_vehicle_id", { ascending: true })
      .range(offset, offset + VEHICLE_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ make: string | null; model: string | null; license_plate: string | null }>;
    for (const v of rows) {
      if (v.make?.trim() || v.model?.trim() || v.license_plate?.trim()) count += 1;
    }
    if (rows.length < VEHICLE_PAGE) break;
  }
  return count;
}

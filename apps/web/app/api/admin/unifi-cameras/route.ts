/**
 * UniFi Protect camera discovery — feeds the pairing picker in the camera
 * editor. Admin session only; the guard app never needs the raw inventory.
 *
 *   GET /api/admin/unifi-cameras → { consoles: [{ consoleId, consoleName, cameras }] }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import { listUnifiCameras, reconcileCameraNames, unifiConfigured } from "@/lib/unifi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  if (!unifiConfigured()) {
    return NextResponse.json({ error: "Camera integration not configured" }, { status: 503 });
  }

  try {
    const consoles = await listUnifiCameras();
    // Opening the picker also refreshes stored names from this fresh list —
    // no extra UniFi round-trip, and the map reflects renames right away.
    void reconcileCameraNames(createUntypedAdminClient(), { consoles });
    return NextResponse.json({ consoles });
  } catch (error) {
    console.error("[admin/unifi-cameras GET] Unexpected error:", error);
    return NextResponse.json({ error: "UniFi request failed" }, { status: 502 });
  }
}

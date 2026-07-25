/**
 * Security-camera markers on the property map.
 *   GET  — admins and scanner devices (the iPads render coverage cones)
 *   POST — admins only; a scanner credential can look but never touch
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, requireAdminOrScanner } from "@/lib/admin-request";
import { readJson } from "@/lib/http";
import { CAMERA_SELECT, serializeCamera } from "@/lib/map-cameras";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import { fetchUnifiCameraName, reconcileCameraNames } from "@/lib/unifi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  normalizedX: z.number().min(0).max(1),
  normalizedY: z.number().min(0).max(1),
  direction: z.number().min(0).max(360).optional().default(0),
  fov: z.number().min(10).max(180).optional().default(70),
  range: z.number().gt(0).max(0.5).optional().default(0.06),
  active: z.boolean().optional().default(true),
  unifiConsoleId: z.string().trim().max(200).nullable().optional().default(null),
  unifiCameraId: z.string().trim().max(200).nullable().optional().default(null),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;

  try {
    const client = createUntypedAdminClient();
    // Keep names in step with Protect (renames propagate here). Self-throttled
    // to ~once per 10 min, so the guard iPads polling this every minute don't
    // hammer UniFi; a no-op when nothing is stale.
    await reconcileCameraNames(client);
    const { data, error } = await client
      .from("map_cameras")
      .select(CAMERA_SELECT)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ cameras: (data ?? []).map(serializeCamera) });
  } catch (error) {
    console.error("[admin/map-cameras GET] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // requireAdmin, not requireAdminOrScanner: cameras are placed at a desk,
  // and a compromised gate device must not be able to redraw the coverage map.
  const auth = await requireAdmin(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const parsed = CreateSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }

    const consoleId = parsed.data.unifiConsoleId || null;
    const unifiCameraId = parsed.data.unifiCameraId || null;
    // The marker's label is the Protect camera's own name — resolve it now so
    // every reader (web, iPads) gets it without talking to UniFi.
    const unifiName =
      consoleId && unifiCameraId ? await fetchUnifiCameraName(consoleId, unifiCameraId) : null;
    if (consoleId && unifiCameraId && !unifiName) {
      return NextResponse.json({ error: "UniFi camera not found" }, { status: 502 });
    }

    const client = createUntypedAdminClient();
    const { data, error } = await client
      .from("map_cameras")
      .insert({
        normalized_x: parsed.data.normalizedX,
        normalized_y: parsed.data.normalizedY,
        direction: parsed.data.direction,
        fov: parsed.data.fov,
        range: parsed.data.range,
        active: parsed.data.active,
        unifi_console_id: consoleId,
        unifi_camera_id: unifiCameraId,
        unifi_camera_name: unifiName,
        created_by_display_name: auth.admin.displayName,
        updated_by_display_name: auth.admin.displayName,
      })
      .select(CAMERA_SELECT)
      .single();
    if (error || !data) throw error ?? new Error("insert returned nothing");
    return NextResponse.json({ camera: serializeCamera(data) });
  } catch (error) {
    console.error("[admin/map-cameras POST] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * One camera marker: PATCH updates, DELETE removes. Admin session only —
 * scanner credentials are read-only for cameras by design.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { readJson } from "@/lib/http";
import { CAMERA_SELECT, serializeCamera } from "@/lib/map-cameras";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import { fetchUnifiCameraName } from "@/lib/unifi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ cameraId: string }>;
}

const UpdateSchema = z.object({
  normalizedX: z.number().min(0).max(1).optional(),
  normalizedY: z.number().min(0).max(1).optional(),
  direction: z.number().min(0).max(360).optional(),
  fov: z.number().min(10).max(180).optional(),
  range: z.number().gt(0).max(0.5).optional(),
  active: z.boolean().optional(),
  // null unpairs; both ids travel together so a stale half never lingers.
  unifiConsoleId: z.string().trim().max(200).nullable().optional(),
  unifiCameraId: z.string().trim().max(200).nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = await requireAdmin(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const parsed = UpdateSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }

    const { cameraId } = await params;
    const patch: Record<string, unknown> = {
      updated_by_display_name: auth.admin.displayName,
      updated_at: new Date().toISOString(),
    };
    const d = parsed.data;
    if (d.normalizedX !== undefined) patch.normalized_x = d.normalizedX;
    if (d.normalizedY !== undefined) patch.normalized_y = d.normalizedY;
    if (d.direction !== undefined) patch.direction = d.direction;
    if (d.fov !== undefined) patch.fov = d.fov;
    if (d.range !== undefined) patch.range = d.range;
    if (d.active !== undefined) patch.active = d.active;
    if (d.unifiConsoleId !== undefined) patch.unifi_console_id = d.unifiConsoleId || null;
    if (d.unifiCameraId !== undefined) patch.unifi_camera_id = d.unifiCameraId || null;
    // Pairing changed → re-resolve the label from Protect; unpairing clears it.
    if (d.unifiConsoleId !== undefined || d.unifiCameraId !== undefined) {
      if (d.unifiConsoleId && d.unifiCameraId) {
        const name = await fetchUnifiCameraName(d.unifiConsoleId, d.unifiCameraId);
        if (!name) return NextResponse.json({ error: "UniFi camera not found" }, { status: 502 });
        patch.unifi_camera_name = name;
      } else {
        patch.unifi_camera_name = null;
      }
    }

    const client = createUntypedAdminClient();
    const { data, error } = await client
      .from("map_cameras")
      .update(patch)
      .eq("id", cameraId)
      .select(CAMERA_SELECT)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Camera not found" }, { status: 404 });
    return NextResponse.json({ camera: serializeCamera(data) });
  } catch (error) {
    console.error("[admin/map-cameras PATCH] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = await requireAdmin(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  try {
    const { cameraId } = await params;
    const client = createUntypedAdminClient();
    const { data, error } = await client
      .from("map_cameras")
      .delete()
      .eq("id", cameraId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Camera not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[admin/map-cameras DELETE] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Live snapshot for a paired map camera. Keyed by OUR camera id — the row
 * holds the UniFi console/camera pairing, so clients never handle UniFi ids.
 * Admins and scanner devices may view (the iPads show live feeds); the UniFi
 * cloud API key stays server-side.
 *
 *   GET /api/admin/map-cameras/{id}/snapshot → image/jpeg
 *   ?w=320 — downscaled variant for map thumbnails (UniFi always serves the
 *   full frame, so shrinking here saves the iPads ~1.3 MB per refresh).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { CAMERA_SELECT } from "@/lib/map-cameras";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import { fetchUnifiSnapshot, unifiConfigured } from "@/lib/unifi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ cameraId: string }>;
}

// Turbopack's dev-mode externals copy of sharp is broken (it rewrites the
// package's internal requires), so resolve it off the real filesystem instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSharp(): Promise<any | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const req = createRequire(path.join(process.cwd(), "package.json"));
    sharpModule = req("sharp");
    // libvips defaults are tuned for a batch CLI, not a long-lived server: a
    // 50MB operation cache plus a per-thread slab pool that glib never returns
    // to the OS. Every frame here is a one-shot resize of a distinct image, so
    // the cache can never hit — it only holds memory. Serialising to one
    // thread bounds the pools too; the guard iPads poll thumbnails on an 8s
    // tick and this route is the single hottest thing the server does.
    sharpModule.cache(false);
    sharpModule.concurrency(1);
  } catch (error) {
    console.error("[cameras/snapshot] sharp unavailable, serving full frames:", error);
    sharpModule = null;
  }
  return sharpModule;
}

export async function GET(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;

  if (!unifiConfigured()) {
    return NextResponse.json({ error: "Camera integration not configured" }, { status: 503 });
  }

  try {
    const { cameraId } = await params;
    const client = createUntypedAdminClient();
    const { data, error } = await client
      .from("map_cameras")
      .select(CAMERA_SELECT)
      .eq("id", cameraId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Camera not found" }, { status: 404 });

    const consoleId = data.unifi_console_id as string | null;
    const unifiCameraId = data.unifi_camera_id as string | null;
    if (!consoleId || !unifiCameraId) {
      return NextResponse.json({ error: "Camera has no UniFi pairing" }, { status: 409 });
    }

    const snap = await fetchUnifiSnapshot(consoleId, unifiCameraId);
    if (!snap) return NextResponse.json({ error: "Snapshot unavailable" }, { status: 502 });

    const widthParam = Number(new URL(request.url).searchParams.get("w"));
    if (Number.isFinite(widthParam) && widthParam >= 64 && widthParam <= 1280) {
      const sharp = await loadSharp();
      if (sharp) {
        const resized = await sharp(Buffer.from(snap.body))
          .resize({ width: Math.round(widthParam) })
          .jpeg({ quality: 72 })
          .toBuffer();
        return new NextResponse(new Uint8Array(resized), {
          headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
        });
      }
      // No sharp → fall through to the full frame; clients scale it themselves.
    }

    return new NextResponse(snap.body, {
      headers: { "content-type": snap.contentType, "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("[admin/map-cameras snapshot] Unexpected error:", error);
    return NextResponse.json({ error: "Snapshot request failed" }, { status: 502 });
  }
}

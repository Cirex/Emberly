import { NextResponse } from "next/server";
import { requireStaffToken } from "@/lib/resman-api-auth";
import { deleteWorkOrderPhoto, fetchWorkOrderPhoto } from "@/lib/work-order-photos";

export const runtime = "nodejs";

/**
 * Single work-order completion photo. Sits beside /api/resman/work-orders the
 * way /api/admin/map-annotation-photos sits beside /api/admin/map-annotations,
 * so a photo id alone is enough to fetch or remove it.
 *
 *   GET    — streams the image bytes.
 *   DELETE — soft delete (sets deleted_at); the listing no longer returns it.
 */

type RouteParams = { params: Promise<{ photoId: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "work-orders");
  if (!auth.ok) return auth.response;

  try {
    const { photoId } = await params;
    const result = await fetchWorkOrderPhoto(photoId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return new NextResponse(result.bytes, {
      headers: {
        "Content-Type": result.contentType,
        // Immutable by construction: replacing a photo is delete + new id.
        "Cache-Control": "private, max-age=3600, immutable",
      },
    });
  } catch (error) {
    console.error("[resman-api work-order-photos] Serve error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "work-orders");
  if (!auth.ok) return auth.response;

  try {
    const { photoId } = await params;
    const result = await deleteWorkOrderPhoto(photoId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[resman-api work-order-photos] Delete error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

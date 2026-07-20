import { NextResponse } from "next/server";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { layersFor } from "@/lib/map-annotation-service";
import { deleteAnnotationPhoto, fetchAnnotationPhoto } from "@/lib/map-annotation-photos";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ photoId: string }> };

/** Streams the image bytes — <img> tags on the admin map point here. */
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;
  const { photoId } = await params;

  const result = await fetchAnnotationPhoto(photoId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return new NextResponse(result.bytes, {
    headers: {
      "Content-Type": result.contentType,
      // Immutable by construction: replacing a photo is delete + new id.
      "Cache-Control": "private, max-age=3600, immutable",
    },
  });
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;
  const { photoId } = await params;

  const result = await deleteAnnotationPhoto(photoId, layersFor(auth.admin));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { readJsonWithinLimit } from "@/lib/http";
import { actorFor, layersFor } from "@/lib/map-annotation-service";
import { createAnnotationPhoto, listAnnotationPhotos } from "@/lib/map-annotation-photos";
import { z } from "zod";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ annotationId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;
  const { annotationId } = await params;
  const photos = await listAnnotationPhotos(annotationId);
  return NextResponse.json({ photos });
}

const CreateSchema = z.object({
  dataBase64: z.string().min(1).max(12_000_000),
  contentType: z.string().min(1).max(64),
});

/**
 * Ceiling on the whole JSON envelope: the 12M-character base64 field the
 * schema allows, plus room for the content type and JSON punctuation. The zod
 * cap alone runs after the body is already buffered, which is the allocation
 * worth avoiding.
 */
const MAX_BODY_BYTES = 13 * 1024 * 1024;

export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireAdminOrScanner(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;
  const { annotationId } = await params;

  const body = await readJsonWithinLimit(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? NextResponse.json({ error: "Photo payload too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid photo payload" }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid photo payload" }, { status: 400 });
  }

  const result = await createAnnotationPhoto(
    annotationId,
    actorFor(auth.admin),
    layersFor(auth.admin),
    parsed.data,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ photo: result.photo }, { status: 201 });
}

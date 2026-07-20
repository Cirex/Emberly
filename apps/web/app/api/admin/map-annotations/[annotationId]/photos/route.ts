import { NextResponse } from "next/server";
import { requireAdminOrScanner } from "@/lib/admin-request";
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

export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;
  const { annotationId } = await params;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
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

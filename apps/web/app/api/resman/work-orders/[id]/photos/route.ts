import { NextResponse } from "next/server";
import { z } from "zod";
import { getResource } from "@/lib/resman-api";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { workOrdersResource } from "@/lib/resman-resources";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import {
  WORK_ORDER_PHOTO_PHASES,
  createWorkOrderPhoto,
  listWorkOrderPhotos,
  workOrderPhotoActor,
} from "@/lib/work-order-photos";

export const runtime = "nodejs";

/**
 * Completion photos on a work order. The maintenance app uploads before/after
 * photos when a technician closes a work order; ResMan write-back is deferred
 * (see ../close/route.ts), so the photos are stored in Emberly and ride into
 * ResMan when the deferred write path is built.
 *
 *   GET  — list the work order's live photos, newest first.
 *   POST — upload one photo (base64 JSON, same wire format as the
 *          map-annotation photo upload).
 */

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;

  try {
    const { id } = await params;
    const photos = await listWorkOrderPhotos(id);
    return NextResponse.json({
      data: photos.map(({ id: photoId, phase, contentType, byteSize, createdBy, createdAt }) => ({
        id: photoId,
        phase,
        contentType,
        byteSize,
        createdBy,
        createdAt,
      })),
    });
  } catch (error) {
    console.error("[resman-api work-order-photos] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// 10MB of image is ~14M base64 characters.
const CreateSchema = z.object({
  dataBase64: z.string().min(1).max(14_000_000),
  contentType: z.string().min(1).max(64),
  phase: z.enum(WORK_ORDER_PHOTO_PHASES).optional(),
});

export async function POST(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid photo payload" }, { status: 400 });
  }

  try {
    const { id } = await params;
    const row = await getResource(
      workOrdersResource,
      id,
      createAdminClient() as UntypedSupabase,
      auth.kind === "scanner",
    );
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const result = await createWorkOrderPhoto(id, workOrderPhotoActor(auth), parsed.data);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const { photo } = result;
    return NextResponse.json(
      { data: { id: photo.id, phase: photo.phase, createdAt: photo.createdAt } },
      { status: 201 },
    );
  } catch (error) {
    console.error("[resman-api work-order-photos] Upload error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

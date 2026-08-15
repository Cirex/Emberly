import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonWithinLimit } from "@/lib/http";
import { getResource } from "@/lib/resman-api";
import { requireStaffToken } from "@/lib/resman-api-auth";
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
  const auth = await requireStaffToken(request, "work-orders");
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

/**
 * Ceiling on the whole JSON envelope, matching the schema's 14M-character
 * base64 field plus the other fields. The zod cap only runs once the body has
 * already been buffered; this stops an oversized upload before that.
 */
const MAX_BODY_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "work-orders");
  if (!auth.ok) return auth.response;

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

  try {
    const { id } = await params;
    // Existence check only. The scanner flag is gone because requireStaffToken
    // already refused scanners — and it was never doing anything here anyway:
    // getResource only narrows when the resource declares `scannerVisible`, and
    // work-orders deliberately doesn't, so passing `true` applied no filter and
    // returned the row regardless.
    const row = await getResource(workOrdersResource, id, createAdminClient() as UntypedSupabase);
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

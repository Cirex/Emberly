/**
 * Mutations on one layered annotation (admin portal + scanner iPads).
 *   PATCH  — update; body carries expectedVersion (409 + currentVersion on conflict)
 *   DELETE — soft delete; same versioning contract
 *
 * A scanner credential can only reach security-layer rows; admins reach both.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { readJson } from "@/lib/http";
import { annotationKindFields, validateAnnotationKindFields } from "@/lib/map-annotation-kinds";
import {
  actorFor,
  deleteLayeredAnnotation,
  layersFor,
  serializeLayeredAnnotation,
  updateLayeredAnnotation,
  type MutationResult,
} from "@/lib/map-annotation-service";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ annotationId: string }>;
}

const UpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().optional().default(""),
    notes: z.string().optional().default(""),
    normalizedX: z.number().min(0).max(1),
    normalizedY: z.number().min(0).max(1),
    colorHex: z.string().trim().min(1),
    icon: z.string().trim().max(40).regex(/^[a-z0-9-]*$/).optional(),
    ...annotationKindFields,
  })
  .superRefine(validateAnnotationKindFields);

const DeleteSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

function mutationResponse(result: MutationResult): NextResponse {
  if (result.ok) return NextResponse.json({ annotation: serializeLayeredAnnotation(result.row) });
  if (result.reason === "not_found") {
    return NextResponse.json({ error: "Annotation not found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: "Annotation version conflict", reason: "version_conflict", currentVersion: result.currentVersion },
    { status: 409 },
  );
}

export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const parsed = UpdateSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }

    const { annotationId } = await params;
    const client = createUntypedAdminClient();
    const result = await updateLayeredAnnotation(
      client,
      annotationId,
      layersFor(auth.admin),
      actorFor(auth.admin),
      parsed.data,
      parsed.data.expectedVersion,
    );
    return mutationResponse(result);
  } catch (error) {
    console.error("[admin/map-annotations PATCH] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const parsed = DeleteSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }

    const { annotationId } = await params;
    const client = createUntypedAdminClient();
    const result = await deleteLayeredAnnotation(
      client,
      annotationId,
      layersFor(auth.admin),
      actorFor(auth.admin),
      parsed.data.expectedVersion,
    );
    if (result.ok) return NextResponse.json({ ok: true });
    return mutationResponse(result);
  } catch (error) {
    console.error("[admin/map-annotations DELETE] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

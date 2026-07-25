/**
 * Layered map annotations for the admin portal and the scanner iPads.
 *   GET  /api/admin/map-annotations?layer=&since=  — list (tombstones with since)
 *   POST /api/admin/map-annotations                — create
 *
 * Admins see and write both layers; a scanner credential is confined to the
 * 'security' layer no matter what it asks for. The external XCMS sync client
 * has its own routes under /api/map, pinned to 'staff'.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { readJson } from "@/lib/http";
import { annotationKindFields, validateAnnotationKindFields } from "@/lib/map-annotation-kinds";
import {
  actorFor,
  createLayeredAnnotation,
  layersFor,
  listLayeredAnnotations,
  serializeLayeredAnnotation,
  type MapAnnotationLayer,
} from "@/lib/map-annotation-service";
import { photoIdsByAnnotation } from "@/lib/map-annotation-photos";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LayerSchema = z.enum(["staff", "security", "utility"]);

const CreateSchema = z
  .object({
    layer: LayerSchema.optional(),
    title: z.string().trim().optional().default(""),
    notes: z.string().optional().default(""),
    normalizedX: z.number().min(0).max(1),
    normalizedY: z.number().min(0).max(1),
    colorHex: z.string().trim().min(1),
    icon: z.string().trim().max(40).regex(/^[a-z0-9-]*$/).optional(),
    ...annotationKindFields,
  })
  .superRefine(validateAnnotationKindFields);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;

  try {
    const url = request.nextUrl ?? new URL(request.url);
    const since = url.searchParams.get("since");
    if (since && Number.isNaN(Date.parse(since))) {
      return NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 });
    }

    const allowed = layersFor(auth.admin);
    const requested = url.searchParams.get("layer");
    let layers = allowed;
    if (requested) {
      const parsed = LayerSchema.safeParse(requested);
      if (!parsed.success) return NextResponse.json({ error: "Invalid layer" }, { status: 400 });
      if (!allowed.includes(parsed.data)) {
        return NextResponse.json({ error: "Not authorized for that layer" }, { status: 403 });
      }
      layers = [parsed.data];
    }

    const client = createUntypedAdminClient();
    const [rows, photoIds] = await Promise.all([
      listLayeredAnnotations(client, layers, since),
      photoIdsByAnnotation(),
    ]);
    return NextResponse.json({
      annotations: rows.map((row) => ({
        ...serializeLayeredAnnotation(row),
        photoIds: photoIds[row.id] ?? [],
      })),
    });
  } catch (error) {
    console.error("[admin/map-annotations GET] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const parsed = CreateSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }

    const actor = actorFor(auth.admin);
    // A scanner writes to its own layer whatever the body says; admins default
    // to staff unless they picked a layer explicitly. Utility kinds are forced
    // onto the 'utility' layer by the service regardless of this choice.
    const layer: MapAnnotationLayer =
      actor.origin === "scanner" ? "security" : (parsed.data.layer ?? "staff");

    const client = createUntypedAdminClient();
    const row = await createLayeredAnnotation(client, layer, actor, parsed.data);
    return NextResponse.json({ annotation: serializeLayeredAnnotation(row) });
  } catch (error) {
    console.error("[admin/map-annotations POST] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/lib/http";
import {
  buildAnnotationAuditInsert,
  buildAnnotationCreateInsert,
  buildAnnotationResponse,
} from "@/lib/map-annotations";
import { MAP_ANNOTATIONS_FEATURE_KEY } from "@/lib/map-sync";
import { authenticateMapSyncRequest } from "@/lib/map-sync-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ propertyId: string }>;
}

const AnnotationCreateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  notes: z.string().optional().default(""),
  normalizedX: z.number().min(0).max(1),
  normalizedY: z.number().min(0).max(1),
  colorHex: z.string().trim().min(1),
});

function parseSince(request: NextRequest): { ok: true; since: string | null } | { ok: false; response: NextResponse } {
  const url = request.nextUrl ?? new URL(request.url);
  const since = url.searchParams.get("since");
  if (!since) return { ok: true, since: null };
  const timestamp = Date.parse(since);
  if (Number.isNaN(timestamp)) {
    return { ok: false, response: NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 }) };
  }
  return { ok: true, since };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const parsedSince = parseSince(request);
    if (!parsedSince.ok) return parsedSince.response;

    const { propertyId } = await params;
    const supabase = createUntypedAdminClient();
    const loaded = await authenticateMapSyncRequest(request, propertyId, "read", supabase);
    if (!loaded.ok) return loaded.response;

    const { syncKey } = loaded;
    const { since } = parsedSince;
    let query = supabase
      .from("map_annotations")
      .select("id, title, notes, normalized_x, normalized_y, color_hex, created_by_display_name, created_at, updated_at, deleted_at, version")
      .eq("resman_account_id", syncKey.resman_account_id)
      .eq("property_id", propertyId)
      .eq("feature_key", MAP_ANNOTATIONS_FEATURE_KEY)
      // The sync client sees the staff layer only — security-layer pins are
      // the guard devices' and admin portal's world.
      .eq("layer", "staff");

    if (since) {
      query = query.gte("updated_at", since);
    } else {
      query = query.is("deleted_at", null);
    }

    const { data: annotations, error } = await query.order("updated_at", { ascending: true });

    if (error) {
      console.error("[map/annotations GET] Query error:", error);
      return NextResponse.json({ error: "Failed to load annotations" }, { status: 500 });
    }

    return NextResponse.json({
      annotations: (annotations ?? []).map((annotation: any) => buildAnnotationResponse(annotation)),
    });
  } catch (error) {
    console.error("[map/annotations GET] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const body = await readJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const parsed = AnnotationCreateSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { propertyId } = await params;
    const supabase = createUntypedAdminClient();
    const loaded = await authenticateMapSyncRequest(request, propertyId, "create", supabase);
    if (!loaded.ok) return loaded.response;

    const { syncKey } = loaded;
    const { data: annotation, error: insertError } = await supabase
      .from("map_annotations")
      .insert(buildAnnotationCreateInsert(syncKey, parsed.data))
      .select("id, title, notes, normalized_x, normalized_y, color_hex, created_by_display_name, created_at, updated_at, deleted_at, version")
      .single();

    if (insertError || !annotation) {
      console.error("[map/annotations POST] Insert error:", insertError);
      return NextResponse.json({ error: "Failed to create annotation" }, { status: 500 });
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAnnotationAuditInsert("annotation.create", syncKey, annotation.id));

    if (auditError) {
      console.error("[map/annotations POST] Audit error:", auditError, { annotationId: annotation.id });
    }

    return NextResponse.json({ annotation: buildAnnotationResponse(annotation) });
  } catch (error) {
    console.error("[map/annotations POST] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

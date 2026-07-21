import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/lib/http";
import { annotationKindFields, validateAnnotationKindFields } from "@/lib/map-annotation-kinds";
import {
  buildAnnotationAuditInsert,
  buildAnnotationDeletePatch,
  buildAnnotationResponse,
  buildAnnotationUpdatePatch,
  ensureExpectedVersion,
} from "@/lib/map-annotations";
import { MAP_ANNOTATIONS_FEATURE_KEY, type MapSyncKeyContext } from "@/lib/map-sync";
import { authenticateMapSyncRequest } from "@/lib/map-sync-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

interface RouteContext {
  params: Promise<{ propertyId: string; annotationId: string }>;
}

const AnnotationUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1),
    notes: z.string().optional().default(""),
    normalizedX: z.number().min(0).max(1),
    normalizedY: z.number().min(0).max(1),
    colorHex: z.string().trim().min(1),
    ...annotationKindFields,
  })
  .superRefine(validateAnnotationKindFields);

const AnnotationDeleteSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

function loadAnnotationQuery(supabase: UntypedSupabase, syncKey: MapSyncKeyContext, propertyId: string, annotationId: string) {
  return supabase
    .from("map_annotations")
    .select("id, title, notes, normalized_x, normalized_y, color_hex, kind, utility_type, points, created_by_display_name, created_at, updated_at, deleted_at, version")
    .eq("id", annotationId)
    .eq("resman_account_id", syncKey.resman_account_id)
    .eq("property_id", propertyId)
    .eq("feature_key", MAP_ANNOTATIONS_FEATURE_KEY)
    // Staff + shared utility layers — a sync key can't reach security-layer pins.
    .in("layer", ["staff", "utility"])
    .is("deleted_at", null)
    .maybeSingle();
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const body = await readJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const parsed = AnnotationUpdateSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { propertyId, annotationId } = await params;
    const supabase = createUntypedAdminClient();
    const loaded = await authenticateMapSyncRequest(request, propertyId, "update", supabase);
    if (!loaded.ok) return loaded.response;

    const { syncKey } = loaded;
    const { data: annotation, error: loadError } = await loadAnnotationQuery(
      supabase,
      syncKey,
      propertyId,
      annotationId,
    );

    if (loadError) {
      console.error("[map/annotations PATCH] Load error:", loadError);
      return NextResponse.json({ error: "Failed to load annotation" }, { status: 500 });
    }
    if (!annotation) {
      return NextResponse.json({ error: "Annotation not found" }, { status: 404 });
    }

    try {
      ensureExpectedVersion(annotation, parsed.data.expectedVersion);
    } catch (error) {
      if (error instanceof Error && error.message === "version_conflict") {
        return NextResponse.json(
          {
            error: "Annotation version conflict",
            reason: "version_conflict",
            currentVersion: annotation.version,
          },
          { status: 409 },
        );
      }
      throw error;
    }

    const { data: updatedAnnotation, error: updateError } = await supabase
      .from("map_annotations")
      .update(buildAnnotationUpdatePatch(syncKey, parsed.data, annotation.version))
      .eq("id", annotationId)
      .eq("resman_account_id", syncKey.resman_account_id)
      .eq("property_id", propertyId)
      .eq("feature_key", MAP_ANNOTATIONS_FEATURE_KEY)
      .in("layer", ["staff", "utility"])
      .eq("version", parsed.data.expectedVersion)
      .is("deleted_at", null)
      .select("id, title, notes, normalized_x, normalized_y, color_hex, kind, utility_type, points, created_by_display_name, created_at, updated_at, deleted_at, version")
      .maybeSingle();

    if (updateError) {
      console.error("[map/annotations PATCH] Update error:", updateError);
      return NextResponse.json({ error: "Failed to update annotation" }, { status: 500 });
    }
    if (!updatedAnnotation) {
      return NextResponse.json(
        {
          error: "Annotation version conflict",
          reason: "version_conflict",
          currentVersion: annotation.version,
        },
        { status: 409 },
      );
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAnnotationAuditInsert("annotation.update", syncKey, annotationId, {
        before: annotation,
        after: updatedAnnotation,
      }));

    if (auditError) {
      console.error("[map/annotations PATCH] Audit error:", auditError, { annotationId });
    }

    return NextResponse.json({ annotation: buildAnnotationResponse(updatedAnnotation) });
  } catch (error) {
    console.error("[map/annotations PATCH] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const body = await readJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const parsed = AnnotationDeleteSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { propertyId, annotationId } = await params;
    const supabase = createUntypedAdminClient();
    const loaded = await authenticateMapSyncRequest(request, propertyId, "delete", supabase);
    if (!loaded.ok) return loaded.response;

    const { syncKey } = loaded;
    const { data: annotation, error: loadError } = await loadAnnotationQuery(
      supabase,
      syncKey,
      propertyId,
      annotationId,
    );

    if (loadError) {
      console.error("[map/annotations DELETE] Load error:", loadError);
      return NextResponse.json({ error: "Failed to load annotation" }, { status: 500 });
    }
    if (!annotation) {
      return NextResponse.json({ error: "Annotation not found" }, { status: 404 });
    }

    try {
      ensureExpectedVersion(annotation, parsed.data.expectedVersion);
    } catch (error) {
      if (error instanceof Error && error.message === "version_conflict") {
        return NextResponse.json(
          {
            error: "Annotation version conflict",
            reason: "version_conflict",
            currentVersion: annotation.version,
          },
          { status: 409 },
        );
      }
      throw error;
    }

    const { data: deletedAnnotation, error: deleteError } = await supabase
      .from("map_annotations")
      .update(buildAnnotationDeletePatch(syncKey, annotation.version))
      .eq("id", annotationId)
      .eq("resman_account_id", syncKey.resman_account_id)
      .eq("property_id", propertyId)
      .eq("feature_key", MAP_ANNOTATIONS_FEATURE_KEY)
      .in("layer", ["staff", "utility"])
      .eq("version", parsed.data.expectedVersion)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();

    if (deleteError) {
      console.error("[map/annotations DELETE] Soft delete error:", deleteError);
      return NextResponse.json({ error: "Failed to delete annotation" }, { status: 500 });
    }
    if (!deletedAnnotation) {
      return NextResponse.json(
        {
          error: "Annotation version conflict",
          reason: "version_conflict",
          currentVersion: annotation.version,
        },
        { status: 409 },
      );
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAnnotationAuditInsert("annotation.delete", syncKey, annotationId, { before: annotation }));

    if (auditError) {
      console.error("[map/annotations DELETE] Audit error:", auditError, { annotationId });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[map/annotations DELETE] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

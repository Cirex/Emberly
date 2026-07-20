import { createAdminClient, createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import {
  MAP_SCOPE,
  layersFor,
  type AnnotationActor,
} from "@/lib/map-annotation-service";

/**
 * First-party photos on map annotations. The guard app captures them in the
 * field and uploads on its sync tick; the admin portal views (and can add or
 * remove) them. Bytes live in the private `map-annotation-photos` Storage
 * bucket; map_annotation_photos rows carry the pointer, author, and scope.
 */

const BUCKET = "map-annotation-photos";
const MAX_BYTES = 8 * 1024 * 1024; // 8MB — plenty for a field JPEG
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

export interface AnnotationPhotoMeta {
  id: string;
  annotationId: string;
  contentType: string;
  byteSize: number;
  createdBy: string;
  createdAt: string | null;
}

const SELECT = "id, annotation_id, content_type, byte_size, created_by, created_at, storage_path";

type PhotoRow = {
  id: string;
  annotation_id: string;
  content_type: string;
  byte_size: number;
  created_by: string;
  created_at: string | null;
  storage_path: string;
};

function meta(row: PhotoRow): AnnotationPhotoMeta {
  return {
    id: row.id,
    annotationId: row.annotation_id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** The annotation's layer, or null when it isn't visible in the map scope. */
async function annotationLayer(supabase: UntypedSupabase, annotationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("map_annotations")
    .select("id, layer")
    .eq("id", annotationId)
    .eq("resman_account_id", MAP_SCOPE.resmanAccountId)
    .eq("property_id", MAP_SCOPE.propertyId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { layer: string } | null)?.layer ?? null;
}

export async function listAnnotationPhotos(annotationId: string): Promise<AnnotationPhotoMeta[]> {
  const supabase = createUntypedAdminClient();
  const { data, error } = await supabase
    .from("map_annotation_photos")
    .select(SELECT)
    .eq("annotation_id", annotationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[map-annotation-photos] List error:", error);
    throw new Error("Failed to list photos");
  }
  return ((data ?? []) as PhotoRow[]).map(meta);
}

/** annotation id → live photo ids, for badge counts on the pin layer. */
export async function photoIdsByAnnotation(): Promise<Record<string, string[]>> {
  const supabase = createUntypedAdminClient();
  const { data } = await supabase
    .from("map_annotation_photos")
    .select("id, annotation_id")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(5000);
  const out: Record<string, string[]> = {};
  for (const row of (data ?? []) as Array<{ id: string; annotation_id: string }>) {
    (out[row.annotation_id] ??= []).push(row.id);
  }
  return out;
}

export type PhotoCreateResult =
  | { ok: true; photo: AnnotationPhotoMeta }
  | { ok: false; status: number; error: string };

export async function createAnnotationPhoto(
  annotationId: string,
  actor: AnnotationActor,
  allowedLayers: ReturnType<typeof layersFor>,
  input: { dataBase64: string; contentType: string },
): Promise<PhotoCreateResult> {
  const contentType = input.contentType.toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return { ok: false, status: 400, error: "Unsupported image type" };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.dataBase64, "base64");
  } catch {
    return { ok: false, status: 400, error: "Invalid base64 payload" };
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    return { ok: false, status: 400, error: "Image is empty or too large" };
  }

  const supabase = createUntypedAdminClient();
  const layer = await annotationLayer(supabase, annotationId);
  if (!layer) return { ok: false, status: 404, error: "Annotation not found" };
  if (!(allowedLayers as string[]).includes(layer)) {
    return { ok: false, status: 403, error: "Layer not permitted" };
  }

  const id = crypto.randomUUID();
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const storagePath = `${annotationId}/${id}.${ext}`;

  const storage = createAdminClient().storage.from(BUCKET);
  const uploaded = await storage.upload(storagePath, bytes, { contentType, upsert: false });
  if (uploaded.error) {
    console.error("[map-annotation-photos] Upload error:", uploaded.error);
    return { ok: false, status: 500, error: "Failed to store photo" };
  }

  const { data, error } = await supabase
    .from("map_annotation_photos")
    .insert({
      id,
      annotation_id: annotationId,
      resman_account_id: MAP_SCOPE.resmanAccountId,
      property_id: MAP_SCOPE.propertyId,
      storage_path: storagePath,
      content_type: contentType,
      byte_size: bytes.length,
      created_by: `${actor.origin}:${actor.displayName}`,
    })
    .select(SELECT)
    .single();
  if (error) {
    await storage.remove([storagePath]);
    console.error("[map-annotation-photos] Insert error:", error);
    return { ok: false, status: 500, error: "Failed to record photo" };
  }
  return { ok: true, photo: meta(data as PhotoRow) };
}

export type PhotoFetchResult =
  | { ok: true; contentType: string; bytes: ArrayBuffer }
  | { ok: false; status: number; error: string };

export async function fetchAnnotationPhoto(photoId: string): Promise<PhotoFetchResult> {
  const supabase = createUntypedAdminClient();
  const { data } = await supabase
    .from("map_annotation_photos")
    .select(SELECT)
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as PhotoRow | null;
  if (!row) return { ok: false, status: 404, error: "Photo not found" };

  const download = await createAdminClient().storage.from(BUCKET).download(row.storage_path);
  if (download.error || !download.data) {
    console.error("[map-annotation-photos] Download error:", download.error);
    return { ok: false, status: 500, error: "Failed to read photo" };
  }
  return { ok: true, contentType: row.content_type, bytes: await download.data.arrayBuffer() };
}

export type PhotoDeleteResult = { ok: true } | { ok: false; status: number; error: string };

export async function deleteAnnotationPhoto(
  photoId: string,
  allowedLayers: ReturnType<typeof layersFor>,
): Promise<PhotoDeleteResult> {
  const supabase = createUntypedAdminClient();
  const { data } = await supabase
    .from("map_annotation_photos")
    .select(SELECT)
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as PhotoRow | null;
  if (!row) return { ok: false, status: 404, error: "Photo not found" };

  const layer = await annotationLayer(supabase, row.annotation_id);
  if (layer && !(allowedLayers as string[]).includes(layer)) {
    return { ok: false, status: 403, error: "Layer not permitted" };
  }

  const { error } = await supabase
    .from("map_annotation_photos")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", photoId);
  if (error) {
    console.error("[map-annotation-photos] Delete error:", error);
    return { ok: false, status: 500, error: "Failed to delete photo" };
  }
  // Best-effort: the row is the record; a stray object is harmless.
  await createAdminClient().storage.from(BUCKET).remove([row.storage_path]);
  return { ok: true };
}

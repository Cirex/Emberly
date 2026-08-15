import { base64ByteLength } from "@/lib/http";
import { createAdminClient, createUntypedAdminClient } from "@/lib/supabase/admin";
import type { AccessTokenSubject } from "@/lib/access-tokens";

/**
 * Completion photos on ResMan work orders. Maintenance techs capture them when
 * closing a work order; ResMan write-back is deferred (the close route is a
 * stub), so bytes live in the private `work-order-photos` Storage bucket and
 * work_order_photos rows carry the pointer, phase, and author. The photos ride
 * into ResMan when the deferred write path is built.
 *
 * Same shape as lib/map-annotation-photos.ts: base64 JSON upload, byte
 * streaming on read, soft delete with best-effort object removal.
 */

export const WORK_ORDER_PHOTOS_BUCKET = "work-order-photos";
export const MAX_WORK_ORDER_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB

export const WORK_ORDER_PHOTO_PHASES = ["before", "after", "completion"] as const;
export type WorkOrderPhotoPhase = (typeof WORK_ORDER_PHOTO_PHASES)[number];

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isWorkOrderPhotoPhase(value: unknown): value is WorkOrderPhotoPhase {
  return (WORK_ORDER_PHOTO_PHASES as readonly unknown[]).includes(value);
}

export type WorkOrderPhotoValidationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function validateWorkOrderPhotoUpload({
  contentType,
  byteSize,
  phase,
}: {
  contentType: string;
  byteSize: number;
  phase: unknown;
}): WorkOrderPhotoValidationResult {
  if (!ALLOWED_TYPES.has(contentType.toLowerCase())) {
    return { ok: false, status: 400, error: "Unsupported image type" };
  }
  if (byteSize <= 0 || byteSize > MAX_WORK_ORDER_PHOTO_BYTES) {
    return { ok: false, status: 400, error: "Image is empty or too large" };
  }
  if (phase !== undefined && !isWorkOrderPhotoPhase(phase)) {
    return { ok: false, status: 400, error: "Invalid phase" };
  }
  return { ok: true };
}

export function workOrderPhotoExtension(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

export function workOrderPhotoStoragePath({
  workOrderId,
  photoId,
  contentType,
}: {
  workOrderId: string;
  photoId: string;
  contentType: string;
}): string {
  return `${workOrderId}/${photoId}.${workOrderPhotoExtension(contentType)}`;
}

export interface WorkOrderPhotoActor {
  createdBy: string;
  createdByAdminId: string;
}

/**
 * Attribution from a `requireResmanApiKey` success. Token callers record the
 * token's label (the staff display name for admin-minted app tokens) plus the
 * admin id when the subject is an admin user; scanner-credential callers are
 * gate devices with no personal identity.
 */
export function workOrderPhotoActor(
  auth: { kind: "token"; subject: AccessTokenSubject } | { kind: "scanner" },
): WorkOrderPhotoActor {
  if (auth.kind === "token") {
    return {
      createdBy: auth.subject.label,
      createdByAdminId: auth.subject.subjectType === "admin_user" ? auth.subject.subjectId : "",
    };
  }
  return { createdBy: "scanner", createdByAdminId: "" };
}

export interface WorkOrderPhotoMeta {
  id: string;
  workOrderId: string;
  phase: WorkOrderPhotoPhase;
  contentType: string;
  byteSize: number;
  createdBy: string;
  createdAt: string | null;
}

const SELECT =
  "id, resman_work_order_id, phase, content_type, byte_size, created_by, created_at, storage_path";

type PhotoRow = {
  id: string;
  resman_work_order_id: string;
  phase: WorkOrderPhotoPhase;
  content_type: string;
  byte_size: number;
  created_by: string;
  created_at: string | null;
  storage_path: string;
};

function meta(row: PhotoRow): WorkOrderPhotoMeta {
  return {
    id: row.id,
    workOrderId: row.resman_work_order_id,
    phase: row.phase,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Non-deleted photos on a work order, newest first. */
export async function listWorkOrderPhotos(workOrderId: string): Promise<WorkOrderPhotoMeta[]> {
  const supabase = createUntypedAdminClient();
  const { data, error } = await supabase
    .from("work_order_photos")
    .select(SELECT)
    .eq("resman_work_order_id", workOrderId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[work-order-photos] List error:", error);
    throw new Error("Failed to list photos");
  }
  return ((data ?? []) as PhotoRow[]).map(meta);
}

/** work order id → live photo count, for badge counts on the admin queue. */
export async function photoCountsByWorkOrder(
  workOrderIds: readonly string[],
): Promise<Record<string, number>> {
  if (workOrderIds.length === 0) return {};
  const supabase = createUntypedAdminClient();
  const { data } = await supabase
    .from("work_order_photos")
    .select("id, resman_work_order_id")
    .in("resman_work_order_id", workOrderIds as string[])
    .is("deleted_at", null);
  const out: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{ resman_work_order_id: string }>) {
    out[row.resman_work_order_id] = (out[row.resman_work_order_id] ?? 0) + 1;
  }
  return out;
}

export type WorkOrderPhotoCreateResult =
  | { ok: true; photo: WorkOrderPhotoMeta }
  | { ok: false; status: number; error: string };

/**
 * Store one photo. The caller has already verified the work order exists
 * (404 semantics live in the route, like the close stub); the FK backstops
 * races with the sync's delete-missing pass.
 */
export async function createWorkOrderPhoto(
  workOrderId: string,
  actor: WorkOrderPhotoActor,
  input: { dataBase64: string; contentType: string; phase?: WorkOrderPhotoPhase },
): Promise<WorkOrderPhotoCreateResult> {
  const contentType = input.contentType.toLowerCase();
  // Validate against the size implied by the base64 length BEFORE decoding —
  // otherwise an oversized upload is fully allocated just to be rejected.
  const declared = validateWorkOrderPhotoUpload({
    contentType,
    byteSize: base64ByteLength(input.dataBase64),
    phase: input.phase,
  });
  if (!declared.ok) return declared;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.dataBase64, "base64");
  } catch {
    return { ok: false, status: 400, error: "Invalid base64 payload" };
  }
  // Buffer.from skips non-base64 characters instead of throwing, so the
  // decoded length can differ from the estimate. Re-check the truth.
  const valid = validateWorkOrderPhotoUpload({
    contentType,
    byteSize: bytes.length,
    phase: input.phase,
  });
  if (!valid.ok) return valid;

  const id = crypto.randomUUID();
  const storagePath = workOrderPhotoStoragePath({ workOrderId, photoId: id, contentType });

  const storage = createAdminClient().storage.from(WORK_ORDER_PHOTOS_BUCKET);
  const uploaded = await storage.upload(storagePath, bytes, { contentType, upsert: false });
  if (uploaded.error) {
    console.error("[work-order-photos] Upload error:", uploaded.error);
    return { ok: false, status: 500, error: "Failed to store photo" };
  }

  const supabase = createUntypedAdminClient();
  const { data, error } = await supabase
    .from("work_order_photos")
    .insert({
      id,
      resman_work_order_id: workOrderId,
      phase: input.phase ?? "completion",
      storage_path: storagePath,
      content_type: contentType,
      byte_size: bytes.length,
      created_by: actor.createdBy,
      created_by_admin_id: actor.createdByAdminId,
    })
    .select(SELECT)
    .single();
  if (error) {
    await storage.remove([storagePath]);
    console.error("[work-order-photos] Insert error:", error);
    return { ok: false, status: 500, error: "Failed to record photo" };
  }
  return { ok: true, photo: meta(data as PhotoRow) };
}

export type WorkOrderPhotoFetchResult =
  | { ok: true; contentType: string; bytes: ArrayBuffer }
  | { ok: false; status: number; error: string };

export async function fetchWorkOrderPhoto(photoId: string): Promise<WorkOrderPhotoFetchResult> {
  const supabase = createUntypedAdminClient();
  const { data } = await supabase
    .from("work_order_photos")
    .select(SELECT)
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as PhotoRow | null;
  if (!row) return { ok: false, status: 404, error: "Photo not found" };

  const download = await createAdminClient()
    .storage.from(WORK_ORDER_PHOTOS_BUCKET)
    .download(row.storage_path);
  if (download.error || !download.data) {
    console.error("[work-order-photos] Download error:", download.error);
    return { ok: false, status: 500, error: "Failed to read photo" };
  }
  return { ok: true, contentType: row.content_type, bytes: await download.data.arrayBuffer() };
}

export type WorkOrderPhotoDeleteResult = { ok: true } | { ok: false; status: number; error: string };

/** Soft delete: sets deleted_at; the object is removed best-effort. */
export async function deleteWorkOrderPhoto(photoId: string): Promise<WorkOrderPhotoDeleteResult> {
  const supabase = createUntypedAdminClient();
  const { data } = await supabase
    .from("work_order_photos")
    .select(SELECT)
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as PhotoRow | null;
  if (!row) return { ok: false, status: 404, error: "Photo not found" };

  const { error } = await supabase
    .from("work_order_photos")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", photoId);
  if (error) {
    console.error("[work-order-photos] Delete error:", error);
    return { ok: false, status: 500, error: "Failed to delete photo" };
  }
  // Best-effort: the row is the record; a stray object is harmless.
  await createAdminClient().storage.from(WORK_ORDER_PHOTOS_BUCKET).remove([row.storage_path]);
  return { ok: true };
}

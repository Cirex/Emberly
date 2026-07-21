import type { Database, Json } from "../types/database";
import { isUtilityKind, type AnnotationKind, type UtilityPoint, type UtilityType } from "./map-annotation-kinds";
import type { MapSyncKeyContext } from "./map-sync";

type MapAnnotationInsert = Database["public"]["Tables"]["map_annotations"]["Insert"];
type MapAnnotationUpdate = Database["public"]["Tables"]["map_annotations"]["Update"];
type MapAnnotationPhotoRow = Database["public"]["Tables"]["map_annotation_photos"]["Row"];
type MapAnnotationAuditInsert = Database["public"]["Tables"]["map_annotation_audit_logs"]["Insert"];

export type AnnotationInput = {
  id?: string;
  title?: string;
  notes?: string;
  normalizedX?: number;
  normalizedY?: number;
  colorHex?: string;
  kind?: AnnotationKind;
  utilityType?: UtilityType | null;
  points?: UtilityPoint[] | null;
};

export type AnnotationRow = Pick<
  Database["public"]["Tables"]["map_annotations"]["Row"],
  | "id"
  | "title"
  | "notes"
  | "normalized_x"
  | "normalized_y"
  | "color_hex"
  | "kind"
  | "utility_type"
  | "points"
  | "line_style"
  | "line_weight"
  | "flow_arrows"
  | "created_by_display_name"
  | "created_at"
  | "updated_at"
  | "deleted_at"
  | "version"
>;

export type AnnotationAuditAction =
  | "annotation.create"
  | "annotation.update"
  | "annotation.delete";

function trimOrEmpty(value: string | undefined): string {
  return value?.trim() ?? "";
}

function clampNormalized(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function ensureExpectedVersion(row: Pick<AnnotationRow, "version">, expectedVersion: number): void {
  if (row.version !== expectedVersion) {
    throw new Error("version_conflict");
  }
}

export function buildAnnotationCreateInsert(
  syncKey: MapSyncKeyContext,
  input: AnnotationInput,
  createdAt = new Date().toISOString(),
): MapAnnotationInsert {
  const kind = input.kind ?? "pin";
  const insert: MapAnnotationInsert = {
    resman_account_id: syncKey.resman_account_id,
    property_id: syncKey.property_id,
    feature_key: syncKey.feature_key,
    // The external sync client is the staff map; the security layer belongs to
    // the guard devices and admin portal (lib/map-annotation-service.ts).
    // Utility kinds always land on the shared 'utility' layer, whichever door
    // wrote them.
    layer: isUtilityKind(kind) ? "utility" : "staff",
    origin: "sync",
    title: trimOrEmpty(input.title),
    notes: trimOrEmpty(input.notes),
    normalized_x: clampNormalized(input.normalizedX),
    normalized_y: clampNormalized(input.normalizedY),
    color_hex: trimOrEmpty(input.colorHex),
    kind,
    utility_type: input.utilityType ?? null,
    points: (input.points ?? null) as Json,
    created_by_key_id: syncKey.id,
    created_by_display_name: syncKey.requester_display_name,
    created_by_resman_login_hash: syncKey.requester_resman_login_hash,
    created_at: createdAt,
    updated_by_key_id: syncKey.id,
    updated_by_display_name: syncKey.requester_display_name,
    updated_at: createdAt,
    version: 1,
  };

  if (input.id) {
    insert.id = input.id;
  }

  return insert;
}

export function buildAnnotationUpdatePatch(
  syncKey: MapSyncKeyContext,
  input: AnnotationInput,
  currentVersion: number,
  updatedAt = new Date().toISOString(),
): MapAnnotationUpdate {
  const kind = input.kind ?? "pin";
  return {
    title: trimOrEmpty(input.title),
    notes: trimOrEmpty(input.notes),
    normalized_x: clampNormalized(input.normalizedX),
    normalized_y: clampNormalized(input.normalizedY),
    color_hex: trimOrEmpty(input.colorHex),
    kind,
    utility_type: input.utilityType ?? null,
    points: (input.points ?? null) as Json,
    // A row updated to (or created as) a utility kind must sit on the shared
    // 'utility' layer; plain-pin updates leave the layer untouched.
    ...(isUtilityKind(kind) ? { layer: "utility" } : {}),
    updated_by_key_id: syncKey.id,
    updated_by_display_name: syncKey.requester_display_name,
    updated_at: updatedAt,
    version: currentVersion + 1,
  };
}

export function buildAnnotationDeletePatch(
  syncKey: MapSyncKeyContext,
  currentVersion: number,
  deletedAt = new Date().toISOString(),
): MapAnnotationUpdate {
  return {
    deleted_by_key_id: syncKey.id,
    deleted_by_display_name: syncKey.requester_display_name,
    deleted_at: deletedAt,
    updated_by_key_id: syncKey.id,
    updated_by_display_name: syncKey.requester_display_name,
    updated_at: deletedAt,
    version: currentVersion + 1,
  };
}

export function buildAnnotationAuditInsert(
  action: AnnotationAuditAction,
  syncKey: MapSyncKeyContext,
  annotationId: string,
  metadata: Record<string, unknown> = {},
): MapAnnotationAuditInsert {
  return {
    resman_account_id: syncKey.resman_account_id,
    property_id: syncKey.property_id,
    feature_key: syncKey.feature_key,
    action,
    annotation_id: annotationId,
    sync_key_id: syncKey.id,
    actor_display_name: syncKey.requester_display_name,
    actor_resman_login_hash: syncKey.requester_resman_login_hash,
    admin_user_id: null,
    admin_display_name: null,
    metadata: metadata as Json,
  };
}

export function buildAnnotationResponse(row: AnnotationRow, photos: MapAnnotationPhotoRow[] = []) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    normalizedX: row.normalized_x,
    normalizedY: row.normalized_y,
    colorHex: row.color_hex,
    kind: row.kind,
    utilityType: row.utility_type,
    points: row.points,
    lineStyle: row.line_style,
    lineWeight: row.line_weight,
    flowArrows: row.flow_arrows,
    createdByDisplayName: row.created_by_display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
    photos: photos.map((photo) => ({
      id: photo.id,
      annotationId: photo.annotation_id,
      storagePath: photo.storage_path,
      contentType: photo.content_type,
      byteSize: photo.byte_size,
      createdAt: photo.created_at,
      deletedAt: photo.deleted_at,
    })),
  };
}

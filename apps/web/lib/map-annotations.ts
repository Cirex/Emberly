import type { Database } from "../types/database";

type MapAnnotationPhotoRow = Database["public"]["Tables"]["map_annotation_photos"]["Row"];

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

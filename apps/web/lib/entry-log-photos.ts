import type { Database } from "@/types/database";

export const ENTRY_LOG_PHOTOS_BUCKET = "entry-log-photos";
export const ENTRY_LOG_PHOTO_RETENTION_DAYS = 30;
export const MAX_ENTRY_LOG_PHOTO_BYTES = 8 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

type EntryLogPhotoInsert = Database["public"]["Tables"]["entry_log_photos"]["Insert"];

type EntryLogForPhoto = {
  id: string;
  resident_id: string | null;
  guest_pass_id: string | null;
  entry_type: "resident" | "guest";
  scanner_id: string | null;
};

type PhotoValidationResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      reason: string;
      reasonCode: "unsupported_media_type" | "file_too_large";
    };

export function validateEntryLogPhotoFile({
  contentType,
  byteSize,
}: {
  contentType: string;
  byteSize: number;
}): PhotoValidationResult {
  if (!ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase())) {
    return {
      ok: false,
      status: 415,
      reason: "Unsupported photo format",
      reasonCode: "unsupported_media_type",
    };
  }

  if (byteSize > MAX_ENTRY_LOG_PHOTO_BYTES) {
    return {
      ok: false,
      status: 413,
      reason: "Photo is too large",
      reasonCode: "file_too_large",
    };
  }

  return { ok: true };
}

export function entryLogPhotoExtension(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "jpg";
  }
}

export function buildEntryLogPhotoStoragePath({
  entryLogId,
  photoId,
  contentType,
}: {
  entryLogId: string;
  photoId: string;
  contentType: string;
}) {
  return `entry-logs/${entryLogId}/${photoId}.${entryLogPhotoExtension(contentType)}`;
}

export function buildEntryLogPhotoInsert({
  entryLog,
  photoId,
  storagePath,
  contentType,
  byteSize,
}: {
  entryLog: EntryLogForPhoto;
  photoId: string;
  storagePath: string;
  contentType: string;
  byteSize: number;
}): EntryLogPhotoInsert {
  return {
    id: photoId,
    entry_log_id: entryLog.id,
    resident_id: entryLog.resident_id,
    guest_pass_id: entryLog.guest_pass_id,
    entry_type: entryLog.entry_type,
    scanner_id: entryLog.scanner_id,
    storage_path: storagePath,
    content_type: contentType,
    byte_size: byteSize,
  };
}

export function buildEntryLogPhotoRetentionFields(capturedAt = new Date()) {
  return {
    flagged_at: null,
    retention_expires_at: new Date(
      capturedAt.getTime() + ENTRY_LOG_PHOTO_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString(),
  };
}

export function isEntryLogPhotoEligibleForCleanup(
  photo: {
    flagged_at: string | null;
    retention_expires_at: string;
  },
  now = new Date()
) {
  if (photo.flagged_at) {
    return false;
  }

  return new Date(photo.retention_expires_at).getTime() <= now.getTime();
}

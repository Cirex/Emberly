import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ENTRY_LOG_PHOTOS_BUCKET,
  buildEntryLogPhotoInsert,
  buildEntryLogPhotoStoragePath,
  validateEntryLogPhotoFile,
} from "@/lib/entry-log-photos";
import {
  authenticateScanner,
  touchScannerLastSeen,
} from "@/lib/scanner-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

export const runtime = "nodejs";

const EntryLogIdSchema = z.string().uuid();

type RouteContext = {
  params: Promise<{ entryLogId: string }>;
};

function jsonError(reason: string, reasonCode: string, status: number) {
  return NextResponse.json({ error: reason, reason, reasonCode }, { status });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { entryLogId } = await params;
  const parsedEntryLogId = EntryLogIdSchema.safeParse(entryLogId);
  if (!parsedEntryLogId.success) {
    return jsonError("Invalid entry log id", "invalid_request", 400);
  }

  const scannerId = new URL(request.url).searchParams.get("scannerId") ?? undefined;
  const supabase = createAdminClient();
  const untypedSupabase = supabase as unknown as UntypedSupabase;
  const authenticatedScanner = await authenticateScanner(request, scannerId, untypedSupabase);

  if (!authenticatedScanner) {
    return jsonError("Scanner authentication required", "scanner_auth_required", 401);
  }

  // Heartbeat only — authentication already confirmed the scanner is enabled.
  await touchScannerLastSeen(untypedSupabase, authenticatedScanner);

  const { data: entryLog, error: entryLogError } = await supabase
    .from("entry_logs")
    .select("id, resident_id, guest_pass_id, entry_type, scanner_id")
    .eq("id", parsedEntryLogId.data)
    .maybeSingle();

  if (entryLogError) {
    console.error("[entry-log-photos] Entry log lookup failed:", entryLogError);
    return jsonError("Entry log lookup failed", "verification_error", 500);
  }

  if (!entryLog) {
    return jsonError("Entry log not found", "entry_log_not_found", 404);
  }

  // Bind the upload to the scanner that created the entry. A null scanner_id is
  // treated as non-matchable (not "skip the check") so a device can't attach
  // photos to an entry log it did not create.
  if (entryLog.scanner_id !== authenticatedScanner.scannerId) {
    return jsonError("Scanner does not match this entry log", "scanner_mismatch", 403);
  }

  const form = await request.formData();
  const photo = form.get("photo");
  if (!(photo instanceof File)) {
    return jsonError("Photo file is required", "invalid_request", 400);
  }

  const validation = validateEntryLogPhotoFile({
    contentType: photo.type,
    byteSize: photo.size,
  });
  if (!validation.ok) {
    return jsonError(validation.reason, validation.reasonCode, validation.status);
  }

  const photoId = randomUUID();
  const storagePath = buildEntryLogPhotoStoragePath({
    entryLogId: entryLog.id,
    photoId,
    contentType: photo.type,
  });
  const photoBuffer = Buffer.from(await photo.arrayBuffer());
  const { error: uploadError } = await supabase.storage
    .from(ENTRY_LOG_PHOTOS_BUCKET)
    .upload(storagePath, photoBuffer, {
      contentType: photo.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("[entry-log-photos] Upload failed:", uploadError);
    return jsonError("Photo upload failed", "upload_failed", 500);
  }

  const insert = buildEntryLogPhotoInsert({
    entryLog,
    photoId,
    storagePath,
    contentType: photo.type,
    byteSize: photo.size,
  });

  const { data: savedPhoto, error: insertError } = await supabase
    .from("entry_log_photos")
    .insert(insert)
    .select("id, entry_log_id, resident_id, guest_pass_id, entry_type, scanner_id, storage_path, content_type, byte_size, created_at")
    .single();

  if (insertError || !savedPhoto) {
    console.error("[entry-log-photos] Metadata insert failed:", insertError);
    await supabase.storage.from(ENTRY_LOG_PHOTOS_BUCKET).remove([storagePath]);
    return jsonError("Photo metadata could not be saved", "metadata_insert_failed", 500);
  }

  return NextResponse.json({ photo: savedPhoto }, { status: 201 });
}

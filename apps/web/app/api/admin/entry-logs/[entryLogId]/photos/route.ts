import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { ENTRY_LOG_PHOTOS_BUCKET } from "@/lib/entry-log-photos";
import { createAdminClient } from "@/lib/supabase/admin";

const EntryLogIdSchema = z.string().uuid();

type RouteContext = {
  params: Promise<{ entryLogId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { entryLogId } = await params;
  const parsedEntryLogId = EntryLogIdSchema.safeParse(entryLogId);
  if (!parsedEntryLogId.success) {
    return NextResponse.json({ error: "Invalid entry log id" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: photos, error } = await supabase
    .from("entry_log_photos")
    .select("id, entry_log_id, resident_id, guest_pass_id, entry_type, scanner_id, storage_path, content_type, byte_size, created_at")
    .eq("entry_log_id", parsedEntryLogId.data)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[admin/entry-log-photos] Query failed:", error);
    return NextResponse.json({ error: "Failed to load entry log photos" }, { status: 500 });
  }

  const signedPhotos = await Promise.all((photos ?? []).map(async (photo) => {
    const { data: signed, error: signedError } = await supabase.storage
      .from(ENTRY_LOG_PHOTOS_BUCKET)
      .createSignedUrl(photo.storage_path, 5 * 60);

    if (signedError) {
      console.error("[admin/entry-log-photos] Signed URL failed:", signedError);
    }

    return {
      id: photo.id,
      entryLogId: photo.entry_log_id,
      residentId: photo.resident_id,
      guestPassId: photo.guest_pass_id,
      entryType: photo.entry_type,
      scannerId: photo.scanner_id,
      contentType: photo.content_type,
      byteSize: photo.byte_size,
      createdAt: photo.created_at,
      url: signed?.signedUrl ?? null,
    };
  }));

  return NextResponse.json({ photos: signedPhotos });
}

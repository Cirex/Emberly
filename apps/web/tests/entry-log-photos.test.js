
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ENTRY_LOG_PHOTOS_BUCKET,
  ENTRY_LOG_PHOTO_RETENTION_DAYS,
  MAX_ENTRY_LOG_PHOTO_BYTES,
  buildEntryLogPhotoInsert,
  buildEntryLogPhotoRetentionFields,
  buildEntryLogPhotoStoragePath,
  isEntryLogPhotoEligibleForCleanup,
  validateEntryLogPhotoFile,
} = require("../lib/entry-log-photos");

test("entry log photo validation accepts supported images within size limits", () => {
  assert.deepEqual(
    validateEntryLogPhotoFile({ contentType: "image/jpeg", byteSize: MAX_ENTRY_LOG_PHOTO_BYTES }),
    { ok: true }
  );
  assert.deepEqual(
    validateEntryLogPhotoFile({ contentType: "image/heic", byteSize: 1024 }),
    { ok: true }
  );
});

test("entry log photo validation rejects unsupported media and oversized files", () => {
  assert.deepEqual(
    validateEntryLogPhotoFile({ contentType: "application/pdf", byteSize: 1024 }),
    {
      ok: false,
      status: 415,
      reason: "Unsupported photo format",
      reasonCode: "unsupported_media_type",
    }
  );
  assert.deepEqual(
    validateEntryLogPhotoFile({ contentType: "image/png", byteSize: MAX_ENTRY_LOG_PHOTO_BYTES + 1 }),
    {
      ok: false,
      status: 413,
      reason: "Photo is too large",
      reasonCode: "file_too_large",
    }
  );
});

test("entry log photo storage paths are scoped to the entry log and content type", () => {
  assert.equal(ENTRY_LOG_PHOTOS_BUCKET, "entry-log-photos");
  assert.equal(
    buildEntryLogPhotoStoragePath({
      entryLogId: "entry-1",
      photoId: "photo-1",
      contentType: "image/jpeg",
    }),
    "entry-logs/entry-1/photo-1.jpg"
  );
  assert.equal(
    buildEntryLogPhotoStoragePath({
      entryLogId: "entry-1",
      photoId: "photo-2",
      contentType: "image/png",
    }),
    "entry-logs/entry-1/photo-2.png"
  );
});

test("entry log photo insert copies scan identity from the entry log", () => {
  assert.deepEqual(
    buildEntryLogPhotoInsert({
      entryLog: {
        id: "entry-1",
        resident_id: "resident-1",
        guest_pass_id: "guest-1",
        entry_type: "guest",
        scanner_id: "gate_a",
      },
      photoId: "photo-1",
      storagePath: "entry-logs/entry-1/photo-1.jpg",
      contentType: "image/jpeg",
      byteSize: 12345,
    }),
    {
      id: "photo-1",
      entry_log_id: "entry-1",
      resident_id: "resident-1",
      guest_pass_id: "guest-1",
      entry_type: "guest",
      scanner_id: "gate_a",
      storage_path: "entry-logs/entry-1/photo-1.jpg",
      content_type: "image/jpeg",
      byte_size: 12345,
    }
  );
});

test("entry log photo retention defaults to 30 days unless flagged", () => {
  const capturedAt = new Date("2026-07-01T12:00:00.000Z");

  assert.equal(ENTRY_LOG_PHOTO_RETENTION_DAYS, 30);
  assert.deepEqual(buildEntryLogPhotoRetentionFields(capturedAt), {
    flagged_at: null,
    retention_expires_at: "2026-07-31T12:00:00.000Z",
  });

  assert.equal(
    isEntryLogPhotoEligibleForCleanup(
      { flagged_at: null, retention_expires_at: "2026-06-30T12:00:00.000Z" },
      capturedAt
    ),
    true
  );
  assert.equal(
    isEntryLogPhotoEligibleForCleanup(
      { flagged_at: "2026-06-29T12:00:00.000Z", retention_expires_at: "2026-06-30T12:00:00.000Z" },
      capturedAt
    ),
    false
  );
  assert.equal(
    isEntryLogPhotoEligibleForCleanup(
      { flagged_at: null, retention_expires_at: "2026-07-02T12:00:00.000Z" },
      capturedAt
    ),
    false
  );
});

test("entry log photo retention schema protects flagged photos from cleanup", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "lib", "supabase", "schema.sql"), "utf8");

  assert.match(schema, /flagged_at timestamptz/);
  assert.match(schema, /retention_expires_at timestamptz not null default \(now\(\) \+ interval '30 days'\)/);
  assert.match(schema, /entry_log_photos_retention_cleanup_idx[\s\S]*where flagged_at is null/);
});

test("entry log photo routes require scanner auth and signed admin URLs", () => {
  const uploadRoute = fs.readFileSync(
    path.join(__dirname, "..", "app", "api", "entry-logs", "[entryLogId]", "photos", "route.ts"),
    "utf8"
  );
  const adminRoute = fs.readFileSync(
    path.join(__dirname, "..", "app", "api", "admin", "entry-logs", "[entryLogId]", "photos", "route.ts"),
    "utf8"
  );

  assert.match(uploadRoute, /authenticateScanner/);
  // authenticateScanner rejects an unauthenticated OR disabled scanner (the old
  // separate isAuthenticatedScannerEnabled check folded into it), surfacing as
  // scanner_auth_required.
  assert.match(uploadRoute, /"scanner_auth_required"/);
  assert.match(uploadRoute, /"scanner_mismatch"/);
  assert.match(uploadRoute, /\.storage\s*\.from\(ENTRY_LOG_PHOTOS_BUCKET\)\s*\.upload/);
  assert.match(uploadRoute, /\.from\("entry_log_photos"\)\s*\.insert/);
  assert.match(adminRoute, /requireAdmin/);
  assert.match(adminRoute, /createSignedUrl/);
});

test("admin entry log listing exposes scan photo counts", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "admin-entry-logs.ts"),
    "utf8"
  );

  assert.match(source, /photo_count: number/);
  assert.match(source, /\.from\("entry_log_photos"\)/);
  assert.match(source, /photoCountsByEntryLogId/);
});

test("admin entry logs show scan photos in a review panel", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "(protected)", "entry-logs", "entry-logs-client.tsx"),
    "utf8"
  );

  assert.match(source, /type EntryLogPhoto/);
  assert.match(source, /selectedPhotoLog/);
  assert.match(source, /fetchAdminJson<EntryLogPhotosResponse>\(`\/api\/admin\/entry-logs\/\$\{log\.id\}\/photos`\)/);
  assert.match(source, />Photos</);
  assert.match(source, /View Photos/);
  assert.match(source, /Scan Photos/);
});

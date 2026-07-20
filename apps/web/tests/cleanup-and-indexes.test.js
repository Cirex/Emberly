
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildCleanupPlan,
  runAppDataCleanup,
} = require("../lib/cleanup");
const { ENTRY_LOG_PHOTOS_BUCKET } = require("../lib/entry-log-photos");

test("cleanup plan computes deterministic app-data cutoffs", () => {
  assert.deepEqual(
    buildCleanupPlan(new Date("2026-06-23T12:00:00.000Z")),
    {
      expiredRateLimitsBefore: "2026-06-23T12:00:00.000Z",
      expiredResidentDevicesBefore: "2026-06-23T12:00:00.000Z",
      resolvedAlertsBefore: "2026-05-24T12:00:00.000Z",
      expiredEntryLogPhotosBefore: "2026-06-23T12:00:00.000Z",
      expiredEntryTokenUsesBefore: "2026-06-23T12:00:00.000Z",
    }
  );
});

function createFakeCleanupClient(results) {
  const calls = [];

  function createChain(table) {
    const call = { table, action: "select", filters: [] };
    calls.push(call);

    const chain = {
      select(columns, options) {
        call.action = options?.head ? "count" : "select";
        call.columns = columns;
        return chain;
      },
      delete() {
        call.action = "delete";
        return chain;
      },
      update(patch) {
        call.action = "update";
        call.patch = patch;
        return chain;
      },
      eq(column, value) {
        call.filters.push(["eq", column, value]);
        return chain;
      },
      lte(column, value) {
        call.filters.push(["lte", column, value]);
        return chain;
      },
      is(column, value) {
        call.filters.push(["is", column, value]);
        return chain;
      },
      in(column, values) {
        call.filters.push(["in", column, values]);
        return chain;
      },
      then(resolve, reject) {
        const result = results[`${call.table}:${call.action}`]
          ?? { data: null, error: null, count: 0 };
        return Promise.resolve(result).then(resolve, reject);
      },
    };

    return chain;
  }

  return {
    calls,
    from: (table) => createChain(table),
    storage: {
      from: (bucket) => ({
        async remove(paths) {
          calls.push({ table: `storage:${bucket}`, action: "remove", paths });
          return results[`storage:${bucket}:remove`] ?? { data: null, error: null };
        },
      }),
    },
  };
}

test("app data cleanup purges expired unflagged entry log photos from storage and the database", async () => {
  const supabase = createFakeCleanupClient({
    "entry_log_photos:select": {
      data: [
        { id: "photo-1", storage_path: "entry-logs/entry-1/photo-1.jpg" },
        { id: "photo-2", storage_path: "entry-logs/entry-2/photo-2.png" },
      ],
      error: null,
    },
  });

  const result = await runAppDataCleanup(supabase, new Date("2026-06-23T12:00:00.000Z"));

  assert.equal(result.expiredEntryLogPhotosDeleted, 2);

  const photoSelect = supabase.calls.find(
    (call) => call.table === "entry_log_photos" && call.action === "select"
  );
  assert.deepEqual(photoSelect.filters, [
    ["is", "flagged_at", null],
    ["lte", "retention_expires_at", "2026-06-23T12:00:00.000Z"],
  ]);

  const storageRemove = supabase.calls.find(
    (call) => call.table === `storage:${ENTRY_LOG_PHOTOS_BUCKET}`
  );
  assert.deepEqual(storageRemove.paths, [
    "entry-logs/entry-1/photo-1.jpg",
    "entry-logs/entry-2/photo-2.png",
  ]);

  const photoDelete = supabase.calls.find(
    (call) => call.table === "entry_log_photos" && call.action === "delete"
  );
  assert.deepEqual(photoDelete.filters, [["in", "id", ["photo-1", "photo-2"]]]);

  assert.ok(
    supabase.calls.indexOf(storageRemove) < supabase.calls.indexOf(photoDelete),
    "storage objects must be removed before their database rows"
  );
});

test("app data cleanup skips photo deletion when nothing is expired", async () => {
  const supabase = createFakeCleanupClient({
    "entry_log_photos:select": { data: [], error: null },
  });

  const result = await runAppDataCleanup(supabase, new Date("2026-06-23T12:00:00.000Z"));

  assert.equal(result.expiredEntryLogPhotosDeleted, 0);
  assert.equal(
    supabase.calls.some((call) => call.action === "remove" || call.action === "delete"),
    false
  );
});

test("schema keeps indexes for admin and heartbeat workloads", () => {
  const schema = fs.readFileSync(
    path.join(process.cwd(), "lib/supabase/schema.sql"),
    "utf8"
  );

  for (const expected of [
    "guest_passes_created_at_idx",
    "guest_passes_resident_created_at_idx",
    "entry_logs_scanner_entered_at_idx",
    "resident_devices_active_expiry_idx",
    "residents_access_health_idx",
  ]) {
    assert.equal(schema.includes(expected), true, `${expected} missing`);
  }
});

test("resident profile cleanup removes property fields from schema and detail UI", () => {
  const schema = fs.readFileSync(
    path.join(process.cwd(), "lib/supabase/schema.sql"),
    "utf8"
  );
  const residentsTable = schema.match(/create table residents \(([\s\S]*?)\n\);/)?.[1] ?? "";
  const detailClient = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/residents/[id]/resident-detail-client.tsx"),
    "utf8"
  );

  assert.equal(residentsTable.includes("property_name"), false);
  assert.equal(residentsTable.includes("unit_address"), false);
  assert.equal(detailClient.includes("EMBERLY_PROPERTY_NAME"), false);
  assert.equal(detailClient.includes("Emberly Apartments"), false);
});

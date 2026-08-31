const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildCleanupPlan, runAppDataCleanup } = require("../lib/cleanup");
const { ENTRY_LOG_PHOTOS_BUCKET } = require("../lib/entry-log-photos");

test("cleanup plan computes deterministic app-data cutoffs", () => {
  assert.deepEqual(buildCleanupPlan(new Date("2026-06-23T12:00:00.000Z")), {
    expiredRateLimitsBefore: "2026-06-23T12:00:00.000Z",
    expiredResidentDevicesBefore: "2026-06-23T12:00:00.000Z",
    resolvedAlertsBefore: "2026-05-24T12:00:00.000Z",
    expiredEntryLogPhotosBefore: "2026-06-23T12:00:00.000Z",
    expiredEntryTokenUsesBefore: "2026-06-23T12:00:00.000Z",
  });
});

/**
 * PostgREST returns at most this many rows per response no matter what the
 * query asked for, so the fake enforces the same ceiling — a purge that trusts
 * a single read visibly falls short here.
 */
const PAGE_CEILING = 1000;

/**
 * `options.photoRows` seeds a LIVE entry_log_photos table: selects read from it
 * and deletes remove from it, so a purge that pages has something to converge
 * against. An explicit `results` entry still wins, for the no-op delete case.
 */
function createFakeCleanupClient(results, options = {}) {
  const calls = [];
  const photoRows = [...(options.photoRows ?? [])];

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
      order(column, options) {
        call.order = [column, options?.ascending !== false];
        return chain;
      },
      limit(count) {
        call.limit = count;
        return chain;
      },
      then(resolve, reject) {
        const override = results[`${call.table}:${call.action}`];
        if (call.table === "entry_log_photos" && !override) {
          if (call.action === "select") {
            const size = Math.min(call.limit ?? PAGE_CEILING, PAGE_CEILING);
            return Promise.resolve({ data: photoRows.slice(0, size), error: null }).then(
              resolve,
              reject,
            );
          }
          if (call.action === "delete") {
            const ids = new Set(call.filters.find((filter) => filter[0] === "in")?.[2] ?? []);
            for (let i = photoRows.length - 1; i >= 0; i--) {
              if (ids.has(photoRows[i].id)) photoRows.splice(i, 1);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
        }
        const result = override ?? { data: null, error: null, count: 0 };
        return Promise.resolve(result).then(resolve, reject);
      },
    };

    return chain;
  }

  return {
    calls,
    photoRows,
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
  const supabase = createFakeCleanupClient(
    {},
    {
      photoRows: [
        { id: "photo-1", storage_path: "entry-logs/entry-1/photo-1.jpg" },
        { id: "photo-2", storage_path: "entry-logs/entry-2/photo-2.png" },
      ],
    },
  );

  const result = await runAppDataCleanup(supabase, new Date("2026-06-23T12:00:00.000Z"));

  assert.equal(result.expiredEntryLogPhotosDeleted, 2);

  const photoSelect = supabase.calls.find(
    (call) => call.table === "entry_log_photos" && call.action === "select",
  );
  assert.deepEqual(photoSelect.filters, [
    ["is", "flagged_at", null],
    ["lte", "retention_expires_at", "2026-06-23T12:00:00.000Z"],
  ]);

  const storageRemove = supabase.calls.find(
    (call) => call.table === `storage:${ENTRY_LOG_PHOTOS_BUCKET}`,
  );
  assert.deepEqual(storageRemove.paths, [
    "entry-logs/entry-1/photo-1.jpg",
    "entry-logs/entry-2/photo-2.png",
  ]);

  const photoDelete = supabase.calls.find(
    (call) => call.table === "entry_log_photos" && call.action === "delete",
  );
  assert.deepEqual(photoDelete.filters, [["in", "id", ["photo-1", "photo-2"]]]);

  assert.ok(
    supabase.calls.indexOf(storageRemove) < supabase.calls.indexOf(photoDelete),
    "storage objects must be removed before their database rows",
  );
});

test("app data cleanup skips photo deletion when nothing is expired", async () => {
  const supabase = createFakeCleanupClient({}, { photoRows: [] });

  const result = await runAppDataCleanup(supabase, new Date("2026-06-23T12:00:00.000Z"));

  assert.equal(result.expiredEntryLogPhotosDeleted, 0);
  assert.equal(
    supabase.calls.some((call) => call.action === "remove" || call.action === "delete"),
    false,
  );
});

test("photo retention purges past the single-read row ceiling", async () => {
  // The 30-day retention window is a privacy promise about photographs of
  // residents and their guests. A single uncapped read only ever sees
  // PAGE_CEILING rows, so any property expiring more than that in one sweep was
  // quietly keeping the remainder forever.
  const photoRows = Array.from({ length: 2500 }, (_, i) => ({
    id: `photo-${String(i).padStart(4, "0")}`,
    storage_path: `entry-logs/entry-${i}/photo-${i}.jpg`,
  }));
  const supabase = createFakeCleanupClient({}, { photoRows });

  const result = await runAppDataCleanup(supabase, new Date("2026-06-23T12:00:00.000Z"));

  assert.equal(result.expiredEntryLogPhotosDeleted, 2500);
  assert.equal(supabase.photoRows.length, 0, "no expired photo may survive the sweep");

  const removedPaths = supabase.calls
    .filter((call) => call.action === "remove")
    .flatMap((call) => call.paths);
  assert.equal(removedPaths.length, 2500, "every storage object is removed too");
});

test("photo retention purge stops instead of spinning when deletes remove nothing", async () => {
  // An RLS-filtered delete reports success while removing no rows; re-selecting
  // the same full page forever would hang the cleanup cron.
  const photoRows = Array.from({ length: 1200 }, (_, i) => ({
    id: `photo-${String(i).padStart(4, "0")}`,
    storage_path: `entry-logs/entry-${i}/photo-${i}.jpg`,
  }));
  const supabase = createFakeCleanupClient(
    { "entry_log_photos:delete": { data: null, error: null } },
    { photoRows },
  );

  await assert.rejects(
    runAppDataCleanup(supabase, new Date("2026-06-23T12:00:00.000Z")),
    /made no progress/,
  );
});

test("schema keeps indexes for admin and heartbeat workloads", () => {
  const schema = fs.readFileSync(path.join(process.cwd(), "lib/supabase/schema.sql"), "utf8");

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
  const schema = fs.readFileSync(path.join(process.cwd(), "lib/supabase/schema.sql"), "utf8");
  const residentsTable = schema.match(/create table residents \(([\s\S]*?)\n\);/)?.[1] ?? "";
  const detailClient = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/residents/[id]/resident-detail-client.tsx"),
    "utf8",
  );

  assert.equal(residentsTable.includes("property_name"), false);
  assert.equal(residentsTable.includes("unit_address"), false);
  assert.equal(detailClient.includes("EMBERLY_PROPERTY_NAME"), false);
  assert.equal(detailClient.includes("Emberly Apartments"), false);
});

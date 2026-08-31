import { ENTRY_LOG_PHOTOS_BUCKET } from "./entry-log-photos";

type CleanupClient = {
  from: (table: string) => any;
  storage: {
    from: (bucket: string) => {
      remove: (paths: string[]) => PromiseLike<{ error: unknown }>;
    };
  };
};

export type CleanupPlan = {
  expiredRateLimitsBefore: string;
  expiredResidentDevicesBefore: string;
  resolvedAlertsBefore: string;
  expiredEntryLogPhotosBefore: string;
  expiredEntryTokenUsesBefore: string;
};

export type CleanupResult = {
  expiredRateLimitsDeleted: number;
  expiredResidentDevicesDeactivated: number;
  resolvedAlertsDeleted: number;
  expiredEntryLogPhotosDeleted: number;
  expiredEntryTokenUsesDeleted: number;
};

const STORAGE_REMOVE_BATCH_SIZE = 100;

/**
 * Ids per `.in(...)` delete. PostgREST puts them in the QUERY STRING, so a
 * batch of 1,000 uuids is ~37 KB of request line — far past what proxies
 * reliably accept, and 5x the 200 the sync worker settled on for the same
 * reason (supabase/sync/src/db/client.ts DELETE_BATCH). The select stays large
 * so the purge still drains quickly; only the delete is chunked.
 */
const PHOTO_DELETE_BATCH_SIZE = 200;

/**
 * Rows one PostgREST response returns regardless of what `.limit()` asks for
 * (the server-side `db-max-rows` ceiling). The purge reads a batch this size
 * and loops, because a single read can never see past it.
 */
const PHOTO_PURGE_BATCH_SIZE = 1_000;

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function buildCleanupPlan(now = new Date()): CleanupPlan {
  return {
    expiredRateLimitsBefore: now.toISOString(),
    expiredResidentDevicesBefore: now.toISOString(),
    resolvedAlertsBefore: daysBefore(now, 30),
    expiredEntryLogPhotosBefore: now.toISOString(),
    expiredEntryTokenUsesBefore: now.toISOString(),
  };
}

async function countRows(
  supabase: CleanupClient,
  table: string,
  filter: (query: any) => any,
): Promise<number> {
  const query = filter(supabase.from(table).select("*", { count: "exact", head: true }));
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function purgeExpiredEntryLogPhotos(
  supabase: CleanupClient,
  expiredBefore: string,
): Promise<number> {
  let deleted = 0;
  let previousFirstId: string | null = null;

  // Purge in batches until a read comes back short. A single uncapped read only
  // ever sees PHOTO_PURGE_BATCH_SIZE rows, so above that rate the 30-day
  // retention window silently stopped being honoured — and these are
  // photographs of residents and their guests, not housekeeping rows.
  for (;;) {
    const { data: expiredPhotos, error: selectError } = await supabase
      .from("entry_log_photos")
      .select("id, storage_path")
      .is("flagged_at", null)
      .lte("retention_expires_at", expiredBefore)
      .order("id", { ascending: true })
      .limit(PHOTO_PURGE_BATCH_SIZE);
    if (selectError) throw selectError;

    const photos = (expiredPhotos ?? []) as Array<{ id: string; storage_path: string }>;
    if (photos.length === 0) return deleted;

    // Every batch deletes its own lowest id, so the next batch must start
    // higher. Seeing the same id twice means the delete reported success while
    // removing nothing, and looping again would spin forever.
    if (photos[0].id === previousFirstId) {
      throw new Error("Entry log photo retention purge made no progress");
    }
    previousFirstId = photos[0].id;

    // Remove storage objects before rows so a failure never orphans objects;
    // re-running the cleanup converges because removes of missing paths succeed.
    const paths = photos.map((photo) => photo.storage_path);
    for (let start = 0; start < paths.length; start += STORAGE_REMOVE_BATCH_SIZE) {
      const { error: removeError } = await supabase.storage
        .from(ENTRY_LOG_PHOTOS_BUCKET)
        .remove(paths.slice(start, start + STORAGE_REMOVE_BATCH_SIZE));
      if (removeError) throw removeError;
    }

    const ids = photos.map((photo) => photo.id);
    for (let start = 0; start < ids.length; start += PHOTO_DELETE_BATCH_SIZE) {
      const { error: deleteError } = await supabase
        .from("entry_log_photos")
        .delete()
        .in("id", ids.slice(start, start + PHOTO_DELETE_BATCH_SIZE));
      if (deleteError) throw deleteError;
    }

    deleted += photos.length;
    // A short batch means nothing expired is left behind it.
    if (photos.length < PHOTO_PURGE_BATCH_SIZE) return deleted;
  }
}

export async function runAppDataCleanup(
  supabase: CleanupClient,
  now = new Date(),
): Promise<CleanupResult> {
  const plan = buildCleanupPlan(now);

  const expiredRateLimitsDeleted = await countRows(supabase, "rate_limits", (query) =>
    query.lte("expires_at", plan.expiredRateLimitsBefore),
  );
  if (expiredRateLimitsDeleted > 0) {
    const { error } = await supabase
      .from("rate_limits")
      .delete()
      .lte("expires_at", plan.expiredRateLimitsBefore);
    if (error) throw error;
  }

  const expiredResidentDevicesDeactivated = await countRows(supabase, "resident_devices", (query) =>
    query.eq("active", true).lte("expires_at", plan.expiredResidentDevicesBefore),
  );
  if (expiredResidentDevicesDeactivated > 0) {
    const { error } = await supabase
      .from("resident_devices")
      .update({ active: false })
      .eq("active", true)
      .lte("expires_at", plan.expiredResidentDevicesBefore);
    if (error) throw error;
  }

  const resolvedAlertsDeleted = await countRows(supabase, "admin_alerts", (query) =>
    query.eq("status", "resolved").lte("resolved_at", plan.resolvedAlertsBefore),
  );
  if (resolvedAlertsDeleted > 0) {
    const { error } = await supabase
      .from("admin_alerts")
      .delete()
      .eq("status", "resolved")
      .lte("resolved_at", plan.resolvedAlertsBefore);
    if (error) throw error;
  }

  const expiredEntryLogPhotosDeleted = await purgeExpiredEntryLogPhotos(
    supabase,
    plan.expiredEntryLogPhotosBefore,
  );

  // Prune consumed resident entry-token jtis whose TTL has passed — once the
  // token can no longer verify, its replay-guard row is dead weight.
  const expiredEntryTokenUsesDeleted = await countRows(
    supabase,
    "resident_entry_token_uses",
    (query) => query.lte("expires_at", plan.expiredEntryTokenUsesBefore),
  );
  if (expiredEntryTokenUsesDeleted > 0) {
    const { error } = await supabase
      .from("resident_entry_token_uses")
      .delete()
      .lte("expires_at", plan.expiredEntryTokenUsesBefore);
    if (error) throw error;
  }

  return {
    expiredRateLimitsDeleted,
    expiredResidentDevicesDeactivated,
    resolvedAlertsDeleted,
    expiredEntryLogPhotosDeleted,
    expiredEntryTokenUsesDeleted,
  };
}

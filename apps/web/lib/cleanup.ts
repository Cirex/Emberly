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
  filter: (query: any) => any
): Promise<number> {
  const query = filter(supabase.from(table).select("*", { count: "exact", head: true }));
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function purgeExpiredEntryLogPhotos(
  supabase: CleanupClient,
  expiredBefore: string
): Promise<number> {
  const { data: expiredPhotos, error: selectError } = await supabase
    .from("entry_log_photos")
    .select("id, storage_path")
    .is("flagged_at", null)
    .lte("retention_expires_at", expiredBefore);
  if (selectError) throw selectError;

  const photos = (expiredPhotos ?? []) as Array<{ id: string; storage_path: string }>;
  if (photos.length === 0) return 0;

  // Remove storage objects before rows so a failure never orphans objects;
  // re-running the cleanup converges because removes of missing paths succeed.
  const paths = photos.map((photo) => photo.storage_path);
  for (let start = 0; start < paths.length; start += STORAGE_REMOVE_BATCH_SIZE) {
    const { error: removeError } = await supabase.storage
      .from(ENTRY_LOG_PHOTOS_BUCKET)
      .remove(paths.slice(start, start + STORAGE_REMOVE_BATCH_SIZE));
    if (removeError) throw removeError;
  }

  const { error: deleteError } = await supabase
    .from("entry_log_photos")
    .delete()
    .in("id", photos.map((photo) => photo.id));
  if (deleteError) throw deleteError;

  return photos.length;
}

export async function runAppDataCleanup(
  supabase: CleanupClient,
  now = new Date()
): Promise<CleanupResult> {
  const plan = buildCleanupPlan(now);

  const expiredRateLimitsDeleted = await countRows(
    supabase,
    "rate_limits",
    (query) => query.lte("expires_at", plan.expiredRateLimitsBefore)
  );
  if (expiredRateLimitsDeleted > 0) {
    const { error } = await supabase
      .from("rate_limits")
      .delete()
      .lte("expires_at", plan.expiredRateLimitsBefore);
    if (error) throw error;
  }

  const expiredResidentDevicesDeactivated = await countRows(
    supabase,
    "resident_devices",
    (query) => query.eq("active", true).lte("expires_at", plan.expiredResidentDevicesBefore)
  );
  if (expiredResidentDevicesDeactivated > 0) {
    const { error } = await supabase
      .from("resident_devices")
      .update({ active: false })
      .eq("active", true)
      .lte("expires_at", plan.expiredResidentDevicesBefore);
    if (error) throw error;
  }

  const resolvedAlertsDeleted = await countRows(
    supabase,
    "admin_alerts",
    (query) => query.eq("status", "resolved").lte("resolved_at", plan.resolvedAlertsBefore)
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
    plan.expiredEntryLogPhotosBefore
  );

  // Prune consumed resident entry-token jtis whose TTL has passed — once the
  // token can no longer verify, its replay-guard row is dead weight.
  const expiredEntryTokenUsesDeleted = await countRows(
    supabase,
    "resident_entry_token_uses",
    (query) => query.lte("expires_at", plan.expiredEntryTokenUsesBefore)
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

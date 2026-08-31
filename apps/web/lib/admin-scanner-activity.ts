import { getScannerDeviceHealth } from "@/lib/admin-operations";
import type { AdminScanner, ScannerDeviceRow } from "@/lib/admin-scanners";
import {
  propertyDayKey,
  propertyHour,
  propertyWeekdayShort,
  startOfPropertyDay,
} from "@/lib/property-time";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export type ScannerScan = {
  id: string;
  entry_type: "resident" | "guest";
  tenant_name: string;
  unit_address: string;
  resident_id: string | null;
  entered_at: string;
};

export type ScannerDayBucket = {
  key: string;
  label: string;
  resident: number;
  guest: number;
};

export type ScannerActivity = {
  scanner: AdminScanner;
  days: number;
  todayTotal: number;
  todayResident: number;
  todayGuest: number;
  windowTotal: number;
  residentTotal: number;
  guestTotal: number;
  perDay: ScannerDayBucket[];
  busiestHourLabel: string | null;
  recent: ScannerScan[];
};

/**
 * Rows one PostgREST response returns regardless of what `.limit()` asks for
 * (the server-side `db-max-rows` ceiling).
 */
const POSTGREST_PAGE_SIZE = 1_000;

/** Safety valve on the paged activity scan, well above one scanner's window. */
const ACTIVITY_ROW_CAP = 20_000;

function hourRangeLabel(hour: number): string {
  const fmt = (h: number) => {
    const period = h >= 12 ? "PM" : "AM";
    const base = h % 12 === 0 ? 12 : h % 12;
    return `${base} ${period}`;
  };
  return `${fmt(hour)} – ${fmt((hour + 1) % 24)}`;
}

/** Count of entry-log scans recorded today, keyed by scanner_id. */
export async function getScannerScanCountsToday(): Promise<Record<string, number>> {
  const supabase = createUntypedAdminClient();
  const since = startOfPropertyDay(new Date()).toISOString();

  const { data: deviceRows, error: devicesError } = await supabase
    .from("scanner_devices")
    .select("scanner_id");

  if (devicesError) {
    console.error("[admin/scanner-activity] Scanner list query error:", devicesError);
    return {};
  }

  const scannerIds = [
    ...new Set(
      ((deviceRows ?? []) as Array<{ scanner_id: string | null }>)
        .map((row) => row.scanner_id)
        .filter((scannerId): scannerId is string => Boolean(scannerId)),
    ),
  ];

  // One exact COUNT per scanner rather than fetching today's scan rows and
  // tallying them here: PostgREST caps a row read at ~1000 whatever `.limit()`
  // says, so a busy day quietly under-reported every scanner.
  const counts: Record<string, number> = {};
  await Promise.all(
    scannerIds.map(async (scannerId) => {
      const { count, error } = await supabase
        .from("entry_logs")
        .select("id", { count: "exact", head: true })
        .eq("scanner_id", scannerId)
        .gte("entered_at", since);

      if (error) {
        console.error("[admin/scanner-activity] Today count query error:", error);
        return;
      }
      counts[scannerId] = count ?? 0;
    }),
  );
  return counts;
}

export async function getScannerActivity(
  scannerId: string,
  days = 7,
): Promise<ScannerActivity | null> {
  const supabase = createUntypedAdminClient();

  const { data: deviceRow, error: deviceError } = await supabase
    .from("scanner_devices")
    .select(
      "id, scanner_id, name, location, enabled, secret_rotated_at, last_seen_at, created_at, updated_at",
    )
    .eq("scanner_id", scannerId)
    .maybeSingle();

  if (deviceError) {
    console.error("[admin/scanner-activity] Device query error:", deviceError);
    throw new Error("Failed to fetch scanner");
  }
  if (!deviceRow) return null;

  const device = deviceRow as ScannerDeviceRow;
  const scanner: AdminScanner = { ...device, health: getScannerDeviceHealth(device) };

  const now = new Date();
  const todayMidnight = startOfPropertyDay(now).getTime();
  const windowStart = new Date(todayMidnight - (days - 1) * 86_400_000);

  // Page the window instead of asking for it in one `.limit()`: PostgREST caps
  // a response at POSTGREST_PAGE_SIZE regardless, so the per-day buckets and
  // totals below were computed on a prefix of a busy scanner's window. Ordering
  // newest-first keeps the "recent" list right, and `id` is the unique
  // tiebreaker that makes offset paging a stable total order.
  const scans: ScannerScan[] = [];
  for (let offset = 0; offset < ACTIVITY_ROW_CAP; offset += POSTGREST_PAGE_SIZE) {
    const size = Math.min(POSTGREST_PAGE_SIZE, ACTIVITY_ROW_CAP - offset);
    const { data: rows, error } = await supabase
      .from("entry_logs")
      .select("id, entry_type, tenant_name, unit_address, resident_id, entered_at")
      .eq("scanner_id", scannerId)
      .gte("entered_at", windowStart.toISOString())
      .order("entered_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + size - 1);

    if (error) {
      console.error("[admin/scanner-activity] Activity query error:", error);
      throw new Error("Failed to fetch scanner activity");
    }

    const page = (rows ?? []) as ScannerScan[];
    scans.push(...page);
    // A short page is the only reliable end-of-data signal.
    if (page.length < size) break;
  }

  // Pre-seed one bucket per day in the window, oldest → newest.
  const perDay: ScannerDayBucket[] = [];
  const byKey = new Map<string, ScannerDayBucket>();
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(todayMidnight - offset * 86_400_000);
    const bucket: ScannerDayBucket = {
      key: propertyDayKey(day),
      label: propertyWeekdayShort(day),
      resident: 0,
      guest: 0,
    };
    perDay.push(bucket);
    byKey.set(bucket.key, bucket);
  }

  const todayKey = propertyDayKey(now);
  const hourCounts = new Array<number>(24).fill(0);
  let todayTotal = 0;
  let todayResident = 0;
  let todayGuest = 0;
  let residentTotal = 0;
  let guestTotal = 0;

  for (const scan of scans) {
    const at = new Date(scan.entered_at);
    const key = propertyDayKey(at);
    const bucket = byKey.get(key);
    const isResident = scan.entry_type === "resident";

    if (bucket) {
      if (isResident) bucket.resident += 1;
      else bucket.guest += 1;
    }
    if (isResident) residentTotal += 1;
    else guestTotal += 1;

    hourCounts[propertyHour(at)] += 1;

    if (key === todayKey) {
      todayTotal += 1;
      if (isResident) todayResident += 1;
      else todayGuest += 1;
    }
  }

  let busiestHour = -1;
  let busiestCount = 0;
  hourCounts.forEach((count, hour) => {
    if (count > busiestCount) {
      busiestCount = count;
      busiestHour = hour;
    }
  });

  return {
    scanner,
    days,
    todayTotal,
    todayResident,
    todayGuest,
    windowTotal: scans.length,
    residentTotal,
    guestTotal,
    perDay,
    busiestHourLabel: busiestHour >= 0 ? hourRangeLabel(busiestHour) : null,
    recent: scans.slice(0, 12),
  };
}

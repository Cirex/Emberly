import { subDays } from "date-fns";
import { summarizeResidentAccessHealth } from "@/lib/admin-operations";
import {
  propertyDayKey,
  propertyHour,
  startOfPropertyDay,
  startOfPropertyMonth,
  startOfPropertyWeek,
} from "@/lib/property-time";
import { residentAccessFreshnessMs } from "@/lib/residents";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdminStats = {
  today: {
    total: number;
    resident: number;
    guest: number;
  };
  week: {
    total: number;
    resident: number;
    guest: number;
  };
  month: {
    total: number;
    resident: number;
    guest: number;
  };
  byHour: number[];
  byDay: Array<{ date: string; total: number; resident: number; guest: number }>;
  topUnits: Array<{ unitAddress: string; count: number }>;
  residents: {
    total: number;
    access: ReturnType<typeof summarizeResidentAccessHealth>;
  };
  guestPasses: {
    total: number;
    created: number;
    used: number;
    usageRate: number;
  };
  recentLogs: Array<{
    id: string;
    entry_type: "resident" | "guest";
    tenant_name: string;
    unit_address: string;
    property_name: string;
    entered_at: string;
    scanner_id: string | null;
  }>;
};

type EntryLogSummary = {
  entry_type: string | null;
  entered_at?: string | null;
  unit_address?: string | null;
};

type GuestPassSummary = {
  id: string;
  used_at: string | null;
};

type ResidentAccessSummary = {
  access_allowed: boolean | null;
  access_status: string | null;
  last_resman_verified_at: string | null;
};

export async function getAdminStats(now = new Date()): Promise<AdminStats> {
  const supabase = createAdminClient();
  // Boundaries in the property's zone, not the server's (UTC on Vercel).
  const todayStart = startOfPropertyDay(now).toISOString();
  const weekStart = startOfPropertyWeek(now).toISOString();
  const monthStart = startOfPropertyMonth(now).toISOString();

  // Per-period resident/guest splits come from head:true COUNT queries, never
  // from a fetched-and-filtered row array — the latter silently caps at
  // PostgREST's ~1000-row default, so a busy month would under-count.
  const periodCounts = (sinceIso: string) => ({
    total: supabase.from("entry_logs").select("id", { count: "exact", head: true }).gte("entered_at", sinceIso),
    resident: supabase
      .from("entry_logs")
      .select("id", { count: "exact", head: true })
      .gte("entered_at", sinceIso)
      .eq("entry_type", "resident"),
  });
  const today = periodCounts(todayStart);
  const week = periodCounts(weekStart);
  const month = periodCounts(monthStart);

  // The 7-day histogram must include the NEWEST entries, so order DESCENDING
  // (ascending + the 1000 cap dropped the most recent days first). The limit is
  // a safety valve well above a single property's weekly volume.
  const HISTOGRAM_ROW_CAP = 20_000;

  const [
    residentResult,
    allGuestPassResult,
    todayTotal,
    todayResident,
    weekTotal,
    weekResident,
    monthTotal,
    monthResident,
    recentLogsResult,
    adminRecentLogsResult,
    guestPassResult,
  ] = await Promise.all([
    supabase
      .from("residents")
      .select("access_allowed, access_status, last_resman_verified_at", { count: "exact" }),

    supabase.from("guest_passes").select("id", { count: "exact", head: true }),

    today.total,
    today.resident,
    week.total,
    week.resident,
    month.total,
    month.resident,

    supabase
      .from("entry_logs")
      .select("entry_type, entered_at, unit_address")
      .gte("entered_at", subDays(now, 7).toISOString())
      .order("entered_at", { ascending: false })
      .limit(HISTOGRAM_ROW_CAP),

    supabase
      .from("entry_logs")
      .select("id, entry_type, tenant_name, unit_address, property_name, entered_at, scanner_id")
      .order("entered_at", { ascending: false })
      .limit(50),

    supabase.from("guest_passes").select("id, used_at").gte("created_at", monthStart),
  ]);

  const recentLogs = (recentLogsResult.data ?? []) as EntryLogSummary[];
  const passes = (guestPassResult.data ?? []) as GuestPassSummary[];
  const residents = (residentResult.data ?? []) as ResidentAccessSummary[];

  const split = (total: number | null, resident: number | null) => {
    const t = total ?? 0;
    const r = resident ?? 0;
    return { total: t, resident: r, guest: Math.max(t - r, 0) };
  };

  const byHour: number[] = Array(24).fill(0);
  for (const log of recentLogs) {
    if (!log.entered_at) continue;
    byHour[propertyHour(new Date(log.entered_at))]++;
  }

  // The 7 property-local day keys, oldest→newest, derived from today's local
  // midnight so the labels never drift across a UTC boundary.
  const todayMidnight = startOfPropertyDay(now).getTime();
  const byDayKeys: string[] = [];
  for (let i = 6; i >= 0; i--) byDayKeys.push(propertyDayKey(new Date(todayMidnight - i * 86_400_000)));
  const dayBuckets = new Map<string, { total: number; resident: number; guest: number }>(
    byDayKeys.map((k) => [k, { total: 0, resident: 0, guest: 0 }]),
  );
  for (const log of recentLogs) {
    if (!log.entered_at) continue;
    const bucket = dayBuckets.get(propertyDayKey(new Date(log.entered_at)));
    if (!bucket) continue;
    bucket.total++;
    if (log.entry_type === "resident") bucket.resident++;
    else if (log.entry_type === "guest") bucket.guest++;
  }
  const byDay: AdminStats["byDay"] = byDayKeys.map((date) => ({ date, ...dayBuckets.get(date)! }));

  const unitCounts: Record<string, number> = {};
  for (const log of recentLogs) {
    if (!log.unit_address) continue;
    unitCounts[log.unit_address] = (unitCounts[log.unit_address] ?? 0) + 1;
  }

  const usedPasses = passes.filter((pass) => pass.used_at !== null).length;

  return {
    today: split(todayTotal.count, todayResident.count),
    week: split(weekTotal.count, weekResident.count),
    month: split(monthTotal.count, monthResident.count),
    byHour,
    byDay,
    topUnits: Object.entries(unitCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([unitAddress, count]) => ({ unitAddress, count })),
    residents: {
      total: residentResult.count ?? residents.length,
      access: summarizeResidentAccessHealth(residents, now.getTime(), residentAccessFreshnessMs()),
    },
    guestPasses: {
      total: allGuestPassResult.count ?? 0,
      created: passes.length,
      used: usedPasses,
      usageRate: passes.length > 0 ? Math.round((usedPasses / passes.length) * 100) : 0,
    },
    recentLogs: (adminRecentLogsResult.data ?? []) as AdminStats["recentLogs"],
  };
}

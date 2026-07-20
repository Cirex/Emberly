import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Admin data-access for the ResMan work-order mirror (resman_work_orders).
 * Read-only, service-role — same pattern as admin-resman-units.ts.
 *
 * The whole table (~4k rows) is fetched once per page load and aggregated in
 * memory: every stat on the page (aging, medians, monthly volume, category and
 * technician mixes) needs a full scan anyway, and one code path over one
 * snapshot keeps the counts and the queue consistent with each other.
 */

export type ResmanWorkOrderRow = {
  resman_work_order_id: string;
  number: string;
  resman_unit_id: string | null;
  unit_number: string;
  status: string;
  category: string;
  title: string;
  technician: string;
  date_reported: string | null;
  date_completed: string | null;
  is_make_ready: boolean;
  callback_status: string;
};

export type WorkOrderStatusFilter = "open" | "completed" | "canceled" | "all";

export type WorkOrderStats = {
  total: number;
  open: number;
  openNotStarted: number;
  openInProgress: number;
  openScheduled: number;
  openAging31Plus: number;
  openMedianAgeDays: number | null;
  agingBuckets: Array<{ label: string; count: number }>;
  completedCount: number;
  medianCompletionDays: number | null;
  p90CompletionDays: number | null;
  reportedThisMonth: number;
  reportedLastMonth: number;
  callbacksFlagged: number;
  monthly: Array<{ month: string; label: string; count: number; partial: boolean }>;
  categories: Array<{ name: string; count: number }>;
  technicians: Array<{ name: string; count: number }>;
  repeatUnits: Array<{ unitNumber: string; unitId: string | null; count: number }>;
  lastSyncedAt: string | null;
};

export type WorkOrdersResult = {
  orders: ResmanWorkOrderRow[];
  total: number;
  page: number;
  limit: number;
  stats: WorkOrderStats;
  /** Every category / technician present, for the filter dropdowns. */
  categoryOptions: string[];
  technicianOptions: string[];
};

const OPEN_STATUSES = new Set(["Not Started", "Scheduled", "In Progress"]);

const SELECT =
  "resman_work_order_id, number, resman_unit_id, unit_number, status, category, title, technician, date_reported, date_completed, is_make_ready, callback_status";

async function fetchAllWorkOrders(supabase: UntypedSupabase): Promise<ResmanWorkOrderRow[]> {
  const rows: ResmanWorkOrderRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("resman_work_orders")
      .select(SELECT)
      .order("resman_work_order_id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      console.error("[admin/resman-work-orders] Query error:", error);
      throw new Error("Failed to fetch work orders");
    }
    const chunk = (data ?? []) as unknown as ResmanWorkOrderRow[];
    rows.push(...chunk);
    if (chunk.length < pageSize) return rows;
  }
}

function daysBetween(fromIso: string, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - Date.parse(fromIso)) / 86_400_000));
}

function median(sortedAscending: number[]): number | null {
  if (sortedAscending.length === 0) return null;
  return sortedAscending[Math.floor(sortedAscending.length / 2)];
}

function computeStats(rows: ResmanWorkOrderRow[], lastSyncedAt: string | null, now: Date): WorkOrderStats {
  const open = rows.filter((r) => OPEN_STATUSES.has(r.status));

  const openAges = open
    .filter((r) => r.date_reported)
    .map((r) => daysBetween(r.date_reported as string, now))
    .sort((a, b) => a - b);
  const agingBuckets = [
    { label: "0–3 days", max: 3, count: 0 },
    { label: "4–7 days", max: 7, count: 0 },
    { label: "8–14 days", max: 14, count: 0 },
    { label: "15–30 days", max: 30, count: 0 },
    { label: "31+ days", max: Infinity, count: 0 },
  ];
  for (const age of openAges) (agingBuckets.find((b) => age <= b.max) as { count: number }).count += 1;

  const completionDays = rows
    .filter((r) => r.date_completed && r.date_reported)
    .map((r) => Math.max(0, Math.round((Date.parse(r.date_completed as string) - Date.parse(r.date_reported as string)) / 86_400_000)))
    .sort((a, b) => a - b);

  const byMonth = new Map<string, number>();
  for (const r of rows) {
    if (!r.date_reported) continue;
    const key = r.date_reported.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
  }
  const thisMonth = now.toISOString().slice(0, 7);
  const monthKeys: string[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    monthKeys.push(d.toISOString().slice(0, 7));
  }
  const monthly = monthKeys.map((month) => ({
    month,
    label: new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    count: byMonth.get(month) ?? 0,
    partial: month === thisMonth,
  }));
  const lastMonthKey = monthKeys[monthKeys.length - 2];

  const tally = (pick: (r: ResmanWorkOrderRow) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const key = pick(r).trim();
      if (!key) continue;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  };

  const unitTally = new Map<string, { unitId: string | null; count: number }>();
  for (const r of rows) {
    if (!r.unit_number) continue;
    const entry = unitTally.get(r.unit_number) ?? { unitId: r.resman_unit_id, count: 0 };
    entry.count += 1;
    entry.unitId ??= r.resman_unit_id;
    unitTally.set(r.unit_number, entry);
  }

  return {
    total: rows.length,
    open: open.length,
    openNotStarted: open.filter((r) => r.status === "Not Started").length,
    openInProgress: open.filter((r) => r.status === "In Progress").length,
    openScheduled: open.filter((r) => r.status === "Scheduled").length,
    openAging31Plus: agingBuckets[4].count,
    openMedianAgeDays: median(openAges),
    agingBuckets: agingBuckets.map(({ label, count }) => ({ label, count })),
    completedCount: completionDays.length,
    medianCompletionDays: median(completionDays),
    p90CompletionDays: completionDays.length > 0 ? completionDays[Math.floor(completionDays.length * 0.9)] : null,
    reportedThisMonth: byMonth.get(thisMonth) ?? 0,
    reportedLastMonth: byMonth.get(lastMonthKey) ?? 0,
    callbacksFlagged: rows.filter((r) => r.callback_status === "possible" || r.callback_status === "confirmed").length,
    monthly,
    categories: tally((r) => r.category).slice(0, 6),
    technicians: tally((r) => r.technician).slice(0, 5),
    repeatUnits: [...unitTally.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([unitNumber, { unitId, count }]) => ({ unitNumber, unitId, count })),
    lastSyncedAt,
  };
}

export async function getResmanWorkOrders(
  params: {
    status?: WorkOrderStatusFilter;
    category?: string;
    technician?: string;
    search?: string;
    /** Restrict to open orders reported 31+ days ago (the aging KPI's slice). */
    aging?: boolean;
    page?: number;
    limit?: number;
  } = {},
): Promise<WorkOrdersResult> {
  const supabase = createUntypedAdminClient();
  const status = params.status ?? "open";
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(200, Math.max(1, params.limit ?? 100));

  const [rows, latest] = await Promise.all([
    fetchAllWorkOrders(supabase),
    supabase
      .from("resman_work_orders")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const lastSyncedAt = (latest.data as { synced_at: string | null } | null)?.synced_at ?? null;
  const now = new Date();
  const stats = computeStats(rows, lastSyncedAt, now);

  let filtered = rows;
  if (status === "open") filtered = filtered.filter((r) => OPEN_STATUSES.has(r.status));
  else if (status === "completed") filtered = filtered.filter((r) => r.status === "Completed" || r.status === "Closed");
  else if (status === "canceled") filtered = filtered.filter((r) => r.status === "Canceled");
  if (params.aging) {
    filtered = filtered.filter(
      (r) => OPEN_STATUSES.has(r.status) && r.date_reported && daysBetween(r.date_reported, now) >= 31,
    );
  }
  if (params.category) filtered = filtered.filter((r) => r.category === params.category);
  if (params.technician) filtered = filtered.filter((r) => r.technician === params.technician);
  const needle = params.search?.trim().toLowerCase();
  if (needle) {
    filtered = filtered.filter(
      (r) =>
        r.title.toLowerCase().includes(needle) ||
        r.unit_number.toLowerCase().includes(needle) ||
        r.number.toLowerCase().includes(needle),
    );
  }

  // Open queue reads oldest-first (the actionable slice); history reads newest-first.
  const noDate = status === "open" ? "9999-99-99" : "";
  filtered = [...filtered].sort((a, b) => {
    const da = a.date_reported ?? noDate;
    const db = b.date_reported ?? noDate;
    return status === "open" ? da.localeCompare(db) : db.localeCompare(da);
  });

  const total = filtered.length;
  const start = (page - 1) * limit;

  const options = (pick: (r: ResmanWorkOrderRow) => string) =>
    [...new Set(rows.map(pick).map((s) => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  return {
    orders: filtered.slice(start, start + limit),
    total,
    page,
    limit,
    stats,
    categoryOptions: options((r) => r.category),
    technicianOptions: options((r) => r.technician),
  };
}

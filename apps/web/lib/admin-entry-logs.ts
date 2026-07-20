import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminPagination } from "@/lib/admin-guest-passes";

export interface EntryLog {
  id: string;
  entry_type: "resident" | "guest";
  tenant_name: string;
  unit_address: string;
  property_name: string;
  entered_at: string;
  scanner_id: string | null;
  notes: string | null;
  resident_id: string | null;
  guest_pass_id: string | null;
  photo_count: number;
}

export type AdminEntryLogsResult = {
  logs: EntryLog[];
  pagination: AdminPagination;
};

export type ListAdminEntryLogsParams = {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  propertyName?: string;
  entryType?: "resident" | "guest";
  residentId?: string;
  guestPassId?: string;
};

export async function listAdminEntryLogs({
  page = 1,
  limit = 50,
  from,
  to,
  propertyName,
  entryType,
  residentId,
  guestPassId,
}: ListAdminEntryLogsParams = {}): Promise<AdminEntryLogsResult> {
  const offset = (page - 1) * limit;
  const supabase = createAdminClient();

  let query = supabase
    .from("entry_logs")
    .select(
      "id, entry_type, tenant_name, unit_address, property_name, entered_at, scanner_id, notes, resident_id, guest_pass_id",
      { count: "exact" }
    )
    .order("entered_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (from) {
    query = query.gte("entered_at", from);
  }
  if (to) {
    query = query.lte("entered_at", to);
  }
  if (propertyName) {
    query = query.ilike("property_name", `%${propertyName}%`);
  }
  if (entryType) {
    query = query.eq("entry_type", entryType);
  }
  if (residentId) {
    query = query.eq("resident_id", residentId);
  }
  if (guestPassId) {
    query = query.eq("guest_pass_id", guestPassId);
  }

  const { data: logs, error, count } = await query;
  if (error) {
    console.error("[admin/entry-logs] Query error:", error);
    throw new Error("Failed to fetch entry logs");
  }

  const baseLogs = (logs ?? []) as Omit<EntryLog, "photo_count">[];
  const entryLogIds = baseLogs.map((log) => log.id);
  const photoCountsByEntryLogId = new Map<string, number>();

  if (entryLogIds.length > 0) {
    const { data: photos, error: photoError } = await supabase
      .from("entry_log_photos")
      .select("entry_log_id")
      .in("entry_log_id", entryLogIds);

    if (photoError) {
      console.error("[admin/entry-logs] Photo count query error:", photoError);
      throw new Error("Failed to fetch entry log photo counts");
    }

    for (const photo of photos ?? []) {
      photoCountsByEntryLogId.set(
        photo.entry_log_id,
        (photoCountsByEntryLogId.get(photo.entry_log_id) ?? 0) + 1
      );
    }
  }

  const total = count ?? 0;
  const totalPages = Math.ceil(total / limit);

  return {
    logs: baseLogs.map((log) => ({
      ...log,
      photo_count: photoCountsByEntryLogId.get(log.id) ?? 0,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

import { getGuestPassStatus } from "@/lib/admin-data";
import { getResidentAccessHealth, type ResidentAccessHealth } from "@/lib/admin-operations";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdminResidentDetail = {
  resident: {
    id: string;
    resman_ledger_id: string;
    resman_login: string;
    name: string;
    unit_id: string;
    access_allowed: boolean;
    access_status: string | null;
    last_resman_verified_at: string | null;
    created_at: string;
    updated_at: string;
    accessHealth: ResidentAccessHealth;
    ban: { reason: string | null; banned_by: string; banned_at: string } | null;
  };
  guestPasses: Array<{
    id: string;
    guest_name: string;
    guest_email: string;
    expires_at: string;
    used_at: string | null;
    created_at: string;
    status: string;
  }>;
  entryLogs: Array<{
    id: string;
    entry_type: "resident" | "guest";
    tenant_name: string;
    entered_at: string;
    scanner_id: string | null;
    notes: string | null;
    guest_pass_id: string | null;
  }>;
  totals: {
    guestPasses: number;
    activeGuestPasses: number;
    entries: number;
  };
};

export async function getAdminResidentDetail(residentId: string): Promise<AdminResidentDetail | null> {
  const supabase = createAdminClient();

  const [residentResult, passesResult, logsResult, banResult] = await Promise.all([
    supabase
      .from("residents")
      .select(
        "id, resman_ledger_id, resman_login, name, unit_id, access_allowed, access_status, last_resman_verified_at, created_at, updated_at"
      )
      .eq("id", residentId)
      .single(),
    supabase
      .from("guest_passes")
      .select("id, guest_name, guest_email, expires_at, used_at, status, created_at")
      .eq("resident_id", residentId)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("entry_logs")
      .select("id, entry_type, tenant_name, unit_address, property_name, entered_at, scanner_id, notes, guest_pass_id")
      .eq("resident_id", residentId)
      .order("entered_at", { ascending: false })
      .limit(50),
    supabase
      .from("guest_pass_bans")
      .select("id, reason, banned_by, banned_at")
      .eq("resident_id", residentId)
      .maybeSingle(),
  ]);

  if (residentResult.error || !residentResult.data) {
    return null;
  }

  if (passesResult.error || logsResult.error) {
    console.error("[admin/resident detail] Query error:", passesResult.error ?? logsResult.error);
    throw new Error("Failed to fetch resident detail");
  }

  const now = new Date();
  const guestPasses = (passesResult.data ?? []).map((pass) => ({
    ...pass,
    status: getGuestPassStatus(pass, now),
  }));

  return {
    resident: {
      ...residentResult.data,
      accessHealth: getResidentAccessHealth(residentResult.data),
      ban: banResult.data ?? null,
    },
    guestPasses,
    entryLogs: logsResult.data ?? [],
    totals: {
      guestPasses: guestPasses.length,
      activeGuestPasses: guestPasses.filter((pass) => pass.status === "active").length,
      entries: logsResult.data?.length ?? 0,
    },
  };
}

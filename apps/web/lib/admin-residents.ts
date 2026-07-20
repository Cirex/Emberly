import { getResidentAccessHealth, type ResidentAccessHealth } from "@/lib/admin-operations";
import { createAdminClient } from "@/lib/supabase/admin";

export interface AdminResident {
  id: string;
  name: string;
  unit_id: string;
  access_allowed: boolean;
  access_status: string | null;
  last_resman_verified_at: string | null;
  accessHealth: ResidentAccessHealth;
  created_at: string;
  resman_ledger_id: string;
  ban?: { reason: string | null; banned_by: string; banned_at: string } | null;
}

type ResidentRow = Omit<AdminResident, "accessHealth" | "ban"> & {
  guest_pass_bans?: Array<{
    id: string;
    reason: string | null;
    banned_by: string;
    banned_at: string;
  }> | null;
};

export async function listAdminResidents(): Promise<AdminResident[]> {
  const supabase = createAdminClient();

  const { data: residents, error } = await supabase
    .from("residents")
    .select(
      `
      id,
      resman_ledger_id,
      name,
      unit_id,
      access_allowed,
      access_status,
      last_resman_verified_at,
      created_at,
      updated_at,
      guest_pass_bans (
        id,
        reason,
        banned_by,
        banned_at
      )
    `
    )
    .order("name", { ascending: true });

  if (error) {
    console.error("[admin/residents] Query error:", error);
    throw new Error("Failed to fetch residents");
  }

  return ((residents ?? []) as ResidentRow[]).map((resident) => {
    const bans = Array.isArray(resident.guest_pass_bans) ? resident.guest_pass_bans : [];
    const { guest_pass_bans, ...rest } = resident;

    return {
      ...rest,
      ban: bans[0] ?? null,
      accessHealth: getResidentAccessHealth(resident),
    };
  });
}

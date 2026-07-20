import { getScannerDeviceHealth, type ScannerDeviceHealth } from "@/lib/admin-operations";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export type ScannerDeviceRow = {
  id: string;
  scanner_id: string;
  name: string;
  location: string | null;
  enabled: boolean;
  secret_rotated_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AdminScanner = ScannerDeviceRow & {
  health: ScannerDeviceHealth;
};

export async function listAdminScanners(): Promise<AdminScanner[]> {
  const supabase = createUntypedAdminClient();
  const { data, error } = await supabase
    .from("scanner_devices")
    .select("id, scanner_id, name, location, enabled, secret_rotated_at, last_seen_at, created_at, updated_at")
    .order("name", { ascending: true });

  if (error) {
    console.error("[admin/scanners] Query error:", error);
    throw new Error("Failed to fetch scanner devices");
  }

  return ((data ?? []) as ScannerDeviceRow[]).map((scanner) => ({
    ...scanner,
    health: getScannerDeviceHealth(scanner),
  }));
}

/**
 * Map of scanner_id → display name, for showing the human-readable name in logs
 * and activity views instead of the raw scanner id. Unknown ids fall back to the
 * id at the call site.
 */
export async function getScannerNameMap(): Promise<Record<string, string>> {
  const supabase = createUntypedAdminClient();
  const { data, error } = await supabase.from("scanner_devices").select("scanner_id, name");
  if (error) {
    console.error("[admin/scanners] Name-map query error:", error);
    return {};
  }
  const map: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ scanner_id: string; name: string | null }>) {
    if (row.scanner_id && row.name) map[row.scanner_id] = row.name;
  }
  return map;
}

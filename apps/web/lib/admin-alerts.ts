import { deriveAdminAlerts } from "@/lib/admin-operations";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

export type AlertStatusFilter = "open" | "resolved" | "all";

export type AdminAlert = {
  id: string;
  alert_type: string;
  severity: "info" | "warning" | "critical";
  subject_type: "resident" | "guest_pass" | "scanner" | "system";
  subject_id: string;
  title: string;
  detail: string | null;
  metadata: Record<string, unknown>;
  status: "open" | "resolved";
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
};

export async function listAdminAlerts(status: AlertStatusFilter = "open"): Promise<AdminAlert[]> {
  const supabase = createUntypedAdminClient();
  await syncDerivedAlerts(supabase);

  let query = supabase
    .from("admin_alerts")
    .select("id, alert_type, severity, subject_type, subject_id, title, detail, metadata, status, resolved_at, resolved_by, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[admin/alerts] Query error:", error);
    throw new Error("Failed to fetch alerts");
  }

  return (data ?? []) as AdminAlert[];
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

function openAlertKey(alert: { alert_type: string; subject_type: string; subject_id: string }) {
  return `${alert.alert_type}:${alert.subject_type}:${alert.subject_id}`;
}

async function syncDerivedAlerts(supabase: UntypedSupabase) {
  const [residentsResult, scannersResult] = await Promise.all([
    supabase
      .from("residents")
      .select("id, name, unit_id, access_allowed, access_status, last_resman_verified_at"),
    supabase
      .from("scanner_devices")
      .select("scanner_id, name, location, enabled, last_seen_at"),
  ]);

  if (residentsResult.error) throw residentsResult.error;
  if (scannersResult.error) throw scannersResult.error;

  const derived = deriveAdminAlerts({
    residents: residentsResult.data ?? [],
    scanners: scannersResult.data ?? [],
  });

  if (derived.length === 0) return;

  const rows = derived.map((alert) => ({
    alert_type: alert.type,
    severity: alert.severity,
    subject_type: alert.type.startsWith("resident_") ? "resident" : "scanner",
    subject_id: alert.subjectId,
    title: alert.title,
    detail: alert.detail,
    metadata: alert.metadata,
    status: "open",
  }));

  const { data: openAlerts, error: openAlertsError } = await supabase
    .from("admin_alerts")
    .select("id, alert_type, subject_type, subject_id")
    .eq("status", "open");

  if (openAlertsError) throw openAlertsError;

  const openAlertIdByKey = new Map<string, string>(
    (openAlerts ?? []).map((alert: { id: string; alert_type: string; subject_type: string; subject_id: string }) => [
      openAlertKey(alert),
      alert.id,
    ])
  );

  const inserts: typeof rows = [];
  const updates: ((typeof rows)[number] & { id: string })[] = [];
  for (const row of rows) {
    const existingId = openAlertIdByKey.get(openAlertKey(row));
    if (existingId) updates.push({ ...row, id: existingId });
    else inserts.push(row);
  }

  // One round trip instead of one per existing alert — this runs on every admin
  // page load, and the derived set grows with the resident roster.
  //
  // Conflicting on the PRIMARY KEY, not on the partial unique index the comment
  // below is about: every row here carries the id of an alert that is already
  // open with these exact (alert_type, subject_type, subject_id) values, so the
  // update branch rewrites a row's own key with the same values and cannot
  // collide with a different row.
  if (updates.length > 0) {
    const { error } = await supabase.from("admin_alerts").upsert(updates, { onConflict: "id" });
    if (error) throw error;
  }

  if (inserts.length === 0) return;

  // admin_alerts_open_unique_idx is a partial unique index (status = 'open'),
  // which PostgREST upserts cannot target via on_conflict. Concurrent listings
  // may race to insert the same open alert, so unique violations are treated
  // as "another request already created it" instead of failing the listing.
  const { error: insertError } = await supabase.from("admin_alerts").insert(inserts);
  if (!insertError) return;
  if (!isUniqueViolation(insertError)) throw insertError;

  for (const row of inserts) {
    const { error } = await supabase.from("admin_alerts").insert(row);
    if (error && !isUniqueViolation(error)) throw error;
  }
}

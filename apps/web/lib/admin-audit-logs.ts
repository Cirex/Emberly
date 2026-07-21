import { createAdminClient } from "./supabase/admin";
import type { Database, Json } from "../types/database";

export type AdminAuditLogRow = Database["public"]["Tables"]["admin_audit_logs"]["Row"];

export type AdminAuditLog = Omit<AdminAuditLogRow, "created_at"> & {
  created_at: string;
};

function sentenceLabel(value: string): string {
  const label = value.replace(/[._-]+/g, " ").trim();
  if (!label) return "";
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

export function formatAdminAuditAction(action: string): string {
  const actionLabels: Record<string, string> = {
    "access.request": "Request map data access",
    "access.approve": "Approve map data access",
    "access.reject": "Reject map data access",
    "access.revoke": "Revoke map data access",
    "annotation.create": "Create map annotation",
    "annotation.update": "Update map annotation",
    "annotation.delete": "Delete map annotation",
    "resident.require_reauth": "Require resident reauth",
    "resident.pii_reveal": "Reveal resident PII",
    "resident.suspend_access": "Suspend resident access",
    "guest_pass.update": "Update guest pass",
    "scanner.create": "Create scanner",
    "scanner.update": "Update scanner",
    "scanner.rotate_secret": "Rotate scanner secret",
  };

  if (actionLabels[action]) return actionLabels[action];

  return sentenceLabel(action);
}

export function formatAdminAuditTarget(targetType: string, targetId: string): string {
  return `${sentenceLabel(targetType)} ${targetId}`;
}

export function formatAdminAuditMetadata(metadata: Json): string {
  if (!metadata || (typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length === 0)) {
    return "";
  }

  return JSON.stringify(metadata, null, 2);
}

export async function listAdminAuditLogs(limit = 100): Promise<AdminAuditLog[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("admin_audit_logs")
    .select("id, admin_user_id, admin_role, admin_display_name, action, target_type, target_id, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[admin/audit] Query error:", error);
    throw new Error("Failed to fetch audit logs");
  }

  return ((data ?? []) as AdminAuditLogRow[]).map((log) => ({
    ...log,
    created_at: log.created_at ?? new Date(0).toISOString(),
  }));
}

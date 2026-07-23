import type { AdminAuthContext } from "./auth";

type AuditClient = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => PromiseLike<{ error?: unknown }>;
  };
};

export type AdminAuditAction =
  | "resident.require_reauth"
  | "resident.pii_reveal"
  | "resident.suspend_access"
  | "resident.ban_guest_pass"
  | "resident.unban_guest_pass"
  | "unit.ban_guest_pass"
  | "unit.unban_guest_pass"
  | "guest_pass.update"
  | "alert.resolve"
  | "scanner.create"
  | "scanner.update"
  | "scanner.rotate_secret";

export type AdminAuditInput = {
  action: AdminAuditAction;
  targetType: "resident" | "guest_pass" | "alert" | "scanner" | "resman_unit";
  targetId: string;
  metadata?: Record<string, unknown>;
};

export function buildAdminAuditLogInsert(
  admin: AdminAuthContext,
  input: AdminAuditInput,
  createdAt = new Date().toISOString()
): Record<string, unknown> {
  return {
    admin_user_id: admin.adminId,
    admin_role: admin.role,
    admin_display_name: admin.displayName,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    metadata: input.metadata ?? {},
    created_at: createdAt,
  };
}

export async function recordAdminAuditLog(
  supabase: AuditClient,
  admin: AdminAuthContext,
  input: AdminAuditInput
): Promise<void> {
  const { error } = await supabase.from("admin_audit_logs").insert(
    buildAdminAuditLogInsert(admin, input)
  );

  if (error) {
    console.error("[admin-audit] Failed to write audit log:", error);
  }
}

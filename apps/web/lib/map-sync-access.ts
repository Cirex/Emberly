import type { AdminAuthContext, AdminRole } from "./auth";
import {
  MAP_ANNOTATIONS_FEATURE_KEY,
  buildSyncCapabilities,
  createSyncKeySecret,
  hashRequesterLogin,
  hashSecret,
} from "./map-sync";

export type AccessRequestInput = {
  resmanAccountId: string;
  propertyId: string;
  propertyName: string;
  featureKey?: string | null;
  requesterDisplayName?: string | null;
  requesterResmanLogin?: string | null;
  deviceId: string;
  claimToken: string;
};

export type AccessRequestRow = {
  id: string;
  resman_account_id: string;
  property_id: string;
  property_name: string;
  feature_key: string;
  requester_display_name: string | null;
  requester_resman_login_hash: string | null;
  device_id: string;
};

export type AccessAuditAction =
  | "access.request"
  | "access.approve"
  | "access.reject"
  | "access.claim"
  | "access.revoke";

export const MAP_SYNC_MANAGER_ROLES: AdminRole[] = ["property_manager", "security_manager"];

export function canAdminManageMapSync(admin: Pick<AdminAuthContext, "role">): boolean {
  return admin.role === "super_admin" || MAP_SYNC_MANAGER_ROLES.includes(admin.role);
}

export function canViewMapSyncAdmin(
  admin: Pick<AdminAuthContext, "role"> | null | undefined
): admin is Pick<AdminAuthContext, "role"> {
  return !!admin && canAdminManageMapSync(admin);
}

export function buildAccessRequestInsert(input: AccessRequestInput) {
  const requesterDisplayName = input.requesterDisplayName?.trim() || null;

  return {
    resman_account_id: input.resmanAccountId.trim(),
    property_id: input.propertyId.trim(),
    property_name: input.propertyName.trim(),
    feature_key: input.featureKey?.trim() || MAP_ANNOTATIONS_FEATURE_KEY,
    requester_display_name: requesterDisplayName,
    requester_resman_login_hash: hashRequesterLogin(input.requesterResmanLogin),
    device_id: input.deviceId.trim(),
    status: "pending" as const,
    claim_token_hash: hashSecret(input.claimToken),
  };
}

export function buildApprovedRequestPatch(
  admin: Pick<AdminAuthContext, "adminId">,
  approvedAt: string,
) {
  return {
    status: "approved" as const,
    approved_by: admin.adminId,
    approved_at: approvedAt,
    updated_at: approvedAt,
  };
}

export function buildRejectedRequestPatch(
  admin: Pick<AdminAuthContext, "adminId">,
  rejectedAt: string,
  rejectionReason?: string | null,
) {
  return {
    status: "rejected" as const,
    rejected_by: admin.adminId,
    rejected_at: rejectedAt,
    rejection_reason: rejectionReason?.trim() || null,
    updated_at: rejectedAt,
  };
}

export function buildClaimedRequestPatch(claimedAt: string) {
  return {
    status: "claimed" as const,
    updated_at: claimedAt,
  };
}

export function buildRevokedKeyPatch(
  admin: Pick<AdminAuthContext, "adminId">,
  revokedAt: string,
) {
  return {
    active: false,
    revoked_by: admin.adminId,
    revoked_at: revokedAt,
  };
}

export function buildSyncKeyInsert(
  request: AccessRequestRow,
  syncKeySecret = createSyncKeySecret(),
) {
  return {
    key_hash: hashSecret(syncKeySecret),
    resman_account_id: request.resman_account_id,
    property_id: request.property_id,
    property_name: request.property_name,
    feature_key: request.feature_key,
    capabilities: buildSyncCapabilities(),
    requester_display_name: request.requester_display_name,
    requester_resman_login_hash: request.requester_resman_login_hash,
    device_id: request.device_id,
    active: true,
  };
}

export function buildAccessAuditInsert(
  action: AccessAuditAction,
  request: AccessRequestRow,
  admin: Pick<AdminAuthContext, "adminId" | "displayName"> | null,
  metadata: Record<string, unknown> = {},
) {
  return {
    resman_account_id: request.resman_account_id,
    property_id: request.property_id,
    feature_key: request.feature_key,
    action,
    annotation_id: null,
    sync_key_id: typeof metadata.syncKeyId === "string" ? metadata.syncKeyId : null,
    actor_display_name: request.requester_display_name,
    actor_resman_login_hash: request.requester_resman_login_hash,
    admin_user_id: admin?.adminId ?? null,
    admin_display_name: admin?.displayName ?? null,
    metadata,
  };
}

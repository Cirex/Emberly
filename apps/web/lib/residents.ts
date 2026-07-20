import { RESIDENT_ACCESS_STALE_REASON, normalizeUnitLabel } from "@emberly/core";
import type { ResmanPortalAccess } from "./resman-portal";

export type ResidentProvision = {
  resman_ledger_id: string;
  resman_login: string;
  name: string;
  unit_id: string;
  access_allowed: boolean;
  access_status: string | null;
  last_resman_verified_at: string | null;
};

export type HeartbeatValidation =
  | { valid: true }
  | { valid: false; status: 401 | 403; reason: string };

export function buildResidentProvision(input: {
  username: string;
  portalAccess: ResmanPortalAccess;
  verifiedAt?: string;
}): ResidentProvision {
  if (!input.portalAccess.ledgerId) {
    throw new Error("Cannot provision resident without ResMan ledger id");
  }

  if (!input.portalAccess.unitNumber) {
    throw new Error("Cannot provision resident without ResMan unit number");
  }

  const username = input.username.trim();
  const tenantName = input.portalAccess.tenantName?.trim() || username;
  const unitNumber = normalizeUnitLabel(input.portalAccess.unitNumber);

  return {
    resman_ledger_id: input.portalAccess.ledgerId,
    resman_login: username.toLowerCase(),
    name: tenantName,
    unit_id: unitNumber,
    access_allowed: input.portalAccess.allowed,
    access_status: input.portalAccess.status ?? null,
    last_resman_verified_at: input.verifiedAt ?? new Date().toISOString(),
  };
}

export function residentAccessFreshnessMs(): number {
  const configured = Number(process.env.RESIDENT_ACCESS_MAX_AGE_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 20 * 60 * 1000;
}

export function isResidentAccessFresh(
  resident: { access_allowed?: boolean | null; last_resman_verified_at?: string | null },
  now = Date.now(),
  maxAgeMs = residentAccessFreshnessMs()
): boolean {
  if (!resident.access_allowed || !resident.last_resman_verified_at) return false;

  const verifiedAt = Date.parse(resident.last_resman_verified_at);
  if (!Number.isFinite(verifiedAt)) return false;

  return now - verifiedAt <= maxAgeMs;
}

export function getResidentGuestPassEligibility(
  resident: {
    access_allowed?: boolean | null;
    access_status?: string | null;
    last_resman_verified_at?: string | null;
  },
  now = Date.now(),
  maxAgeMs = residentAccessFreshnessMs()
): { allowed: true } | { allowed: false; reason: string; status?: string } {
  if (!resident.last_resman_verified_at) {
    return { allowed: false, reason: "resident_access_never_verified" };
  }
  if (!resident.access_allowed) {
    return {
      allowed: false,
      reason: "resident_access_denied",
      ...(resident.access_status ? { status: resident.access_status } : {}),
    };
  }
  if (!isResidentAccessFresh(resident, now, maxAgeMs)) {
    return { allowed: false, reason: RESIDENT_ACCESS_STALE_REASON };
  }

  return { allowed: true };
}

export function getResidentHeartbeatNextCheckAfter(
  verifiedAt = Date.now(),
  maxAgeMs = residentAccessFreshnessMs()
): string {
  const safetyWindowMs = Math.max(60_000, Math.floor(maxAgeMs / 2));
  return new Date(verifiedAt + safetyWindowMs).toISOString();
}

export function validateResmanHeartbeatAccess(input: {
  tokenLedgerId?: string | null;
  portalAccess: ResmanPortalAccess;
}): HeartbeatValidation {
  if (input.portalAccess.error) {
    return { valid: false, status: 403, reason: input.portalAccess.error };
  }

  if (!input.tokenLedgerId || !input.portalAccess.ledgerId) {
    return { valid: false, status: 401, reason: "resman_ledger_missing" };
  }

  if (input.portalAccess.ledgerId !== input.tokenLedgerId) {
    return { valid: false, status: 401, reason: "resman_ledger_mismatch" };
  }

  if (!input.portalAccess.allowed) {
    return { valid: false, status: 403, reason: "resident_status_not_allowed" };
  }

  return { valid: true };
}

export function buildResidentAccessUpdate(
  validation: HeartbeatValidation,
  portalAccess: ResmanPortalAccess,
  verifiedAt = new Date().toISOString()
): {
  name?: string;
  access_allowed: boolean;
  access_status: string | null;
  last_resman_verified_at: string;
} | null {
  if (!validation.valid) {
    // Only an explicit ResMan denial for the verified ledger is persisted.
    // Ambiguous outcomes (portal errors, missing/mismatched ledgers) must
    // leave the stored access state untouched.
    if (validation.reason !== "resident_status_not_allowed") return null;

    return {
      access_allowed: false,
      access_status: portalAccess.status ?? null,
      last_resman_verified_at: verifiedAt,
    };
  }

  return {
    ...(portalAccess.tenantName?.trim() ? { name: portalAccess.tenantName.trim() } : {}),
    access_allowed: portalAccess.allowed,
    access_status: portalAccess.status ?? null,
    last_resman_verified_at: verifiedAt,
  };
}

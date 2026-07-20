export type PassStatus = "active" | "used" | "expired" | "revoked";

/**
 * Minimal structural input for deriving a guest pass status.
 *
 * Accepts both the snake_case database/API row shape (`used_at`/`expires_at`)
 * and the camelCase client shape (`usedAt`/`expiresAt`). Callers that have
 * already resolved a used flag from richer data can pass `used` directly.
 */
export interface GuestPassStatusSource {
  status?: PassStatus | null;
  /** Additive signal: a truthy value marks the pass as used. */
  used?: boolean | null;
  used_at?: string | null;
  usedAt?: string | null;
  expires_at?: string | null;
  expiresAt?: string | null;
}

/**
 * Single source of truth for guest pass status precedence:
 * revoked > used (used flag, used timestamp, or status) > expired
 * (expires before `now`) > active.
 *
 * Note: apps/web/lib/admin-guest-passes.ts mirrors this precedence as
 * Supabase filter conditions (it cannot call this function); keep both in
 * sync when changing the rules here.
 */
export function getGuestPassStatus(
  pass: GuestPassStatusSource,
  now: Date = new Date()
): PassStatus {
  if (pass.status === "revoked") return "revoked";
  if (pass.used || pass.usedAt || pass.used_at || pass.status === "used") return "used";

  const expiresAt = pass.expiresAt ?? pass.expires_at;
  const expiresAtMs = expiresAt == null ? Number.NaN : Date.parse(expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs < now.getTime()) return "expired";

  return pass.status === "expired" ? "expired" : "active";
}

/**
 * Admin authentication — ResMan staff credentials + break-glass.
 *
 * The dashboard login validates a ResMan staff username/password against the
 * ResMan admin portal (the same OIDC login the sync worker uses) and upserts a
 * local super_admin row in admin_users, keyed by resman_username. The break-glass
 * path (an off-by-default emergency key) is the only non-ResMan way in.
 */
import type { AdminAuthContext, AdminRole } from "./auth";
import { BOOTSTRAP_ADMIN_CONTEXT, verifyBreakGlassKey } from "./auth";
import { validateResmanAdminLogin } from "./resman-admin-login";
import { createUntypedAdminClient, getMissingSupabaseAdminEnvVars } from "./supabase/admin";
import type { UntypedSupabase } from "./supabase/types";

export type AdminLoginResult =
  | { ok: true; admin: AdminAuthContext; personId: string | null }
  | { ok: false; reason: "invalid_credentials" | "unavailable" | "not_configured" };

interface AdminUserRow {
  id: string;
  role: AdminRole;
  display_name: string | null;
  resman_person_id: string | null;
}

/**
 * The stored form of a ResMan staff username.
 *
 * ResMan treats its usernames case-insensitively — the same person signs in as
 * `rdeojeda` one day and `Rdeojeda` the next, and both succeed. We keyed
 * admin_users on the raw string, so the second spelling missed the lookup and
 * inserted a SECOND row for the same person: same GUID, same name, its own id
 * and its own role. Whichever spelling they happened to type decided which
 * account — and therefore which permissions — they logged into.
 *
 * Lowercase is the canonical form. The raw input still goes to ResMan for
 * authentication; only what we store and match on is normalized.
 */
export function normalizeResmanUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Authenticate a ResMan staff username/password. On success, upserts the local
 * admin_users row (super_admin) and returns its AdminAuthContext.
 */
export async function authenticateResmanAdmin(
  username: string,
  password: string,
  client?: UntypedSupabase,
): Promise<AdminLoginResult> {
  const login = await validateResmanAdminLogin(username, password);
  if (!login.ok) return { ok: false, reason: login.reason };

  if (!client && getMissingSupabaseAdminEnvVars().length > 0) {
    return { ok: false, reason: "not_configured" };
  }
  const supabase = client ?? (createUntypedAdminClient());
  const now = new Date().toISOString();
  const resmanUsername = normalizeResmanUsername(username);

  // ResMan's landed page carries the authoritative identity. The full name is
  // what the staff apps match technicians by (work orders name "Ben Bloch", not
  // the "bbloch" username), so it must win over the username fallback.
  const personName = login.identity.personName?.trim() || null;
  const personId = login.identity.personId?.trim() || null;

  const existing = await supabase
    .from("admin_users")
    .select("id, role, display_name, resman_person_id")
    .eq("resman_username", resmanUsername)
    .maybeSingle();
  if (existing.error) return { ok: false, reason: "unavailable" };

  const found = existing.data as AdminUserRow | null;
  if (found) {
    // Upgrade a stale username-only display name to the real name, and backfill
    // the person GUID — without clobbering good data when ResMan omits a field.
    const update: Record<string, unknown> = { last_login_at: now, updated_at: now, active: true };
    if (personName && personName !== found.display_name) update.display_name = personName;
    if (personId && personId !== found.resman_person_id) update.resman_person_id = personId;
    await supabase.from("admin_users").update(update).eq("id", found.id);

    const displayName = personName ?? found.display_name ?? resmanUsername;
    return {
      ok: true,
      admin: { adminId: found.id, role: found.role, displayName },
      personId: personId ?? found.resman_person_id,
    };
  }

  const inserted = await supabase
    .from("admin_users")
    .insert({
      resman_username: resmanUsername,
      display_name: personName ?? resmanUsername,
      resman_person_id: personId,
      // Least privilege: a newly-seen ResMan staff is read-only until an
      // existing super_admin deliberately elevates them. (Previously every new
      // staff was auto-super_admin, so any ResMan login gained full admin.)
      role: "viewer",
      active: true,
      last_login_at: now,
    })
    .select("id, role, display_name, resman_person_id")
    .single();
  if (inserted.error || !inserted.data) return { ok: false, reason: "unavailable" };

  const row = inserted.data as AdminUserRow;
  return {
    ok: true,
    admin: { adminId: row.id, role: row.role, displayName: row.display_name ?? resmanUsername },
    personId: row.resman_person_id,
  };
}

/** Emergency break-glass: an off-by-default env key → bootstrap super_admin. */
export function authenticateBreakGlass(key: string): AdminAuthContext | null {
  return verifyBreakGlassKey(key) ? BOOTSTRAP_ADMIN_CONTEXT : null;
}

// ---- admin_users directory management --------------------------------------

/** The assignable roles, most- to least-privileged. Mirrors AdminRole. */
export const ASSIGNABLE_ADMIN_ROLES: readonly AdminRole[] = [
  "super_admin",
  "property_manager",
  "security_manager",
  "viewer",
];

export function isAssignableAdminRole(value: string): value is AdminRole {
  return (ASSIGNABLE_ADMIN_ROLES as readonly string[]).includes(value);
}

export interface AdminUserSummary {
  id: string;
  resman_username: string;
  display_name: string | null;
  role: AdminRole;
  active: boolean;
  resman_person_id: string | null;
  last_login_at: string | null;
  created_at: string;
}

const ADMIN_USER_COLUMNS =
  "id, resman_username, display_name, role, active, resman_person_id, last_login_at, created_at";

/** List every admin_users row, oldest first. */
export async function listAdminUsers(client: UntypedSupabase): Promise<AdminUserSummary[]> {
  const { data, error } = await client
    .from("admin_users")
    .select(ADMIN_USER_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as AdminUserSummary[];
}

/** Count the active super_admins — used to refuse demoting the last one. */
export async function countActiveSuperAdmins(client: UntypedSupabase): Promise<number> {
  const { count, error } = await client
    .from("admin_users")
    .select("id", { count: "exact", head: true })
    .eq("role", "super_admin")
    .eq("active", true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export type UpdateAdminRoleResult =
  | { ok: true; admin: AdminUserSummary }
  | { ok: false; reason: "not_found" | "last_super_admin" };

/**
 * Change an admin's role. Refuses to demote the last active super_admin, which
 * would lock everyone out of the super_admin-only surfaces (including this one).
 */
export async function updateAdminUserRole(
  client: UntypedSupabase,
  id: string,
  role: AdminRole,
): Promise<UpdateAdminRoleResult> {
  const existing = await client
    .from("admin_users")
    .select("id, role, active")
    .eq("id", id)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const target = existing.data as { id: string; role: AdminRole; active: boolean } | null;
  if (!target) return { ok: false, reason: "not_found" };

  if (target.active && target.role === "super_admin" && role !== "super_admin") {
    if ((await countActiveSuperAdmins(client)) <= 1) {
      return { ok: false, reason: "last_super_admin" };
    }
  }

  const { data, error } = await client
    .from("admin_users")
    .update({ role, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(ADMIN_USER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return { ok: true, admin: data as unknown as AdminUserSummary };
}

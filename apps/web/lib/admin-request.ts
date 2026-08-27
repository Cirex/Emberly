import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE } from "@emberly/core";
import { authenticateAccessToken } from "./access-tokens";
import {
  adminHasRole,
  readAdminSessionToken,
  verifyAdminRequest,
  type AdminAuthContext,
  type AdminRole,
} from "./auth";
import { authenticateScanner, hasScannerCredential, touchScannerLastSeen } from "./scanner-auth";
import { createUntypedAdminClient } from "./supabase/admin";
import type { UntypedSupabase } from "./supabase/types";

// Roles an `eapi_` app token may carry (adminFromApiToken demotes anything
// else to viewer) and that a live admin_users row may refresh a session to.
// `maintenance_tech` only ever arrives via the token path — it is the
// maintenance app's device role (minted by /api/admin/auth/app-token), never a
// human admin_users role, so resolveActiveSessionAdmin simply never sees it.
const ADMIN_ROLES: readonly AdminRole[] = [
  "super_admin",
  "property_manager",
  "security_manager",
  "maintenance_tech",
  "viewer",
];

/** Extract an `eapi_` bearer token, if the request carries one. */
function bearerApiToken(request: Request): string | null {
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer?.startsWith("eapi_") ? bearer : null;
}

/**
 * Resolve a per-user `eapi_` token (minted by /api/admin/auth/app-token for the
 * staff apps) to an admin context — full attribution: actions land under the
 * staff member's own admin_users identity, not a device identity.
 */
async function adminFromApiToken(
  request: Request,
  client: UntypedSupabase,
): Promise<AdminAuthContext | null> {
  const token = bearerApiToken(request);
  if (!token) return null;
  try {
    const subject = await authenticateAccessToken(client, token, "api_resman");
    if (!subject || subject.subjectType !== "admin_user") return null;

    // The token snapshots the role at mint time; the display name comes from
    // the live admin_users row so renames show up without re-issuing tokens.
    const { data } = await client
      .from("admin_users")
      .select("display_name, active")
      .eq("id", subject.subjectId)
      .maybeSingle();
    const row = data as { display_name: string | null; active: boolean } | null;
    if (row && row.active === false) return null;

    const role: AdminRole = (ADMIN_ROLES as readonly string[]).includes(subject.role)
      ? (subject.role as AdminRole)
      : "viewer";
    return {
      adminId: subject.subjectId,
      role,
      displayName: row?.display_name ?? subject.label,
    };
  } catch {
    return null;
  }
}

/**
 * Re-validate a session-derived admin context against the live `admin_users`
 * row. The admin session cookie is signed + time-boxed but otherwise opaque, so
 * without this a deactivated admin (or one whose role was downgraded) keeps full
 * access until their 8h cookie expires. Returns null when the admin is gone or
 * `active === false`, and refreshes the role from the row (mirroring the
 * app-token path, which already re-checks `active`).
 *
 * The break-glass identity ("bootstrap-admin") has no DB row and is intentionally
 * skipped — it is emergency access gated only by the break-glass key.
 */
async function resolveActiveSessionAdmin(
  admin: AdminAuthContext | null,
): Promise<AdminAuthContext | null> {
  if (!admin) return null;
  if (admin.adminId === "bootstrap-admin") return admin;
  try {
    const client = createUntypedAdminClient();
    const { data } = await client
      .from("admin_users")
      .select("active, role, display_name")
      .eq("id", admin.adminId)
      .maybeSingle();
    const row = data as { active: boolean; role: string | null; display_name: string | null } | null;
    if (!row || row.active === false) return null;
    const role: AdminRole = (ADMIN_ROLES as readonly string[]).includes(row.role ?? "")
      ? (row.role as AdminRole)
      : admin.role;
    return { adminId: admin.adminId, role, displayName: row.display_name ?? admin.displayName };
  } catch {
    // A DB blip must not silently widen access, but must also not lock every
    // admin out on a transient error — fall back to the signed session claims.
    return admin;
  }
}

export type AdminRequestResult =
  | { ok: true; admin: AdminAuthContext }
  | { ok: false; response: NextResponse };

/** A scanner credential is treated as a scoped security_manager for shared routes. */
const SCANNER_ADMIN_ROLE: AdminRole = "security_manager";

/**
 * Shared admin route-handler preamble: verifies the admin session (or admin
 * key header) and optionally enforces a role requirement.
 *
 * Returns a 401 response when unauthenticated and a 403 response when the
 * admin lacks one of the allowed roles (super_admin always passes).
 */
export async function requireAdmin(
  request: Request,
  options: { roles?: AdminRole[] } = {}
): Promise<AdminRequestResult> {
  const admin = await resolveActiveSessionAdmin(await verifyAdminRequest(request));
  if (!admin) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (options.roles && !adminHasRole(admin, options.roles)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { ok: true, admin };
}

/**
 * Like requireAdmin, but also accepts a scanner credential (the scanner secret
 * via Bearer / x-scanner-key). A valid scanner is represented as a scoped
 * security_manager, so the security-scanner app reaches the guest-pass
 * feed/revoke endpoints with its own per-scanner key rather than a shared admin
 * key. The key self-identifies; `?scannerId=<id>` is optional and only used by
 * devices provisioned before that.
 */
export async function requireAdminOrScanner(
  request: Request,
  options: { roles?: AdminRole[] } = {}
): Promise<AdminRequestResult> {
  const admin = await resolveActiveSessionAdmin(await verifyAdminRequest(request));
  if (admin) {
    if (options.roles && !adminHasRole(admin, options.roles)) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { ok: true, admin };
  }

  // Per-user app token (EmberlyMaintenance staff sign-in) — checked before the
  // scanner branch: both arrive as Bearer, but only eapi_ tokens match here.
  const tokenAdmin = await adminFromApiToken(
    request,
    createUntypedAdminClient(),
  );
  if (tokenAdmin) {
    if (options.roles && !adminHasRole(tokenAdmin, options.roles)) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { ok: true, admin: tokenAdmin };
  }

  if (hasScannerCredential(request)) {
    const scannerId = new URL(request.url).searchParams.get("scannerId");
    const client = createUntypedAdminClient();
    const scanner = await authenticateScanner(request, scannerId, client);
    if (scanner) {
      // Every authenticated scanner call is a heartbeat — the app's background
      // syncs land here, so a device that never scans a QR still reads as
      // online instead of "never seen" on the Scanners page. Shared with the
      // verify-pass / entry-log paths via touchScannerLastSeen.
      await touchScannerLastSeen(client, scanner);
      const scannerAdmin: AdminAuthContext = {
        adminId: `scanner:${scanner.scannerId}`,
        role: SCANNER_ADMIN_ROLE,
        displayName: `Scanner ${scanner.scannerId}`,
      };
      if (options.roles && !adminHasRole(scannerAdmin, options.roles)) {
        return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
      }
      return { ok: true, admin: scannerAdmin };
    }
  }

  return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
}

/**
 * Server-component variant: reads the admin session cookie the same way the
 * protected admin layout does and returns the admin context, if any.
 */
export async function getAdminFromSessionCookie(): Promise<AdminAuthContext | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  return resolveActiveSessionAdmin(sessionCookie ? readAdminSessionToken(sessionCookie) : null);
}

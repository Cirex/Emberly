/**
 * Auth for the private read-only property-management REST API (`/api/resman/*`).
 *
 * Two credential types are accepted (the shared RESMAN_API_KEY is retired):
 *   1. A per-user/integration API token (`eapi_…`), via `Authorization: Bearer`
 *      or the `x-resman-api-key` header, resolved against access_tokens
 *      (kind='api_resman').
 *   2. A scanner credential — the scanner secret (Bearer or `x-scanner-key`) —
 *      so each security-scanner app reaches the API with its own rotatable key
 *      (used for unit sync + guest-pass verification). The key self-identifies;
 *      `?scannerId=<id>` is optional and only used by devices provisioned before
 *      that.
 *
 * Fails closed; present-but-invalid attempts are rate-limited per source IP.
 */
import { NextResponse } from "next/server";
import { type AccessTokenSubject, authenticateAccessToken } from "./access-tokens";
import { requestSource } from "./http";
import { checkRateLimit } from "./rate-limit";
import { authenticateScanner, hasScannerCredential } from "./scanner-auth";
import { createUntypedAdminClient } from "./supabase/admin";

export const RESMAN_API_KEY_HEADER = "x-resman-api-key";

const FAILED_ATTEMPT_MAX = 10;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export type ResmanApiAuthResult =
  /** kind lets routes vary visibility by caller: scanners are gate devices,
   *  not back-office tools, and some rows are none of their business. The token
   *  subject rides along so routes can gate on the token's role + scopes. */
  | { ok: true; kind: "token"; subject: AccessTokenSubject }
  | { ok: true; kind: "scanner" }
  | { ok: false; response: NextResponse };

/**
 * Field-device tokens (the maintenance + security apps mint an `eapi_` token via
 * /api/admin/auth/app-token with a SCOPED role) may read only the operational
 * surface their app needs. Back-office roles (staff, super_admin, …) have no
 * entry here and are unrestricted by role — limited only by their explicit
 * `scopes`. This is the read-side complement to the scanner `scannerVisible`
 * allowlist: without it, a leaked maintenance token could pull the financial
 * ledger (`transactions`), the resident roster (`residents`/`leases`), and MLGW
 * billing, none of which the maintenance app has any business reading.
 */
const FIELD_DEVICE_RESOURCE_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  security_manager: new Set(["units", "work-orders"]),
};

/** True when this token's role is a scoped field-device role (not back-office). */
export function isFieldDeviceRole(role: string): boolean {
  return role in FIELD_DEVICE_RESOURCE_ALLOWLIST;
}

/**
 * Whether an authenticated token is forbidden from a resource. `resource` is the
 * name matched against the token's `scopes`; `capability` (defaults to
 * `resource`) is matched against the role allowlist, letting a PII-heavy bespoke
 * route (e.g. the guard-only unit detail pane) be denied to field devices while
 * still counting against the `units` scope for back-office tokens.
 */
export function tokenForbiddenForResource(
  subject: AccessTokenSubject,
  resource: string,
  capability: string = resource,
): boolean {
  const roleAllow = FIELD_DEVICE_RESOURCE_ALLOWLIST[subject.role];
  if (roleAllow && !roleAllow.has(capability)) return true;
  if (subject.scopes.length > 0 && !subject.scopes.includes(resource)) return true;
  return false;
}

/** Extract an `eapi_` API token from the Authorization/x-resman-api-key header. */
function apiToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer?.startsWith("eapi_")) return bearer;
  const header = request.headers.get(RESMAN_API_KEY_HEADER)?.trim();
  if (header?.startsWith("eapi_")) return header;
  return null;
}

export async function requireResmanApiKey(request: Request): Promise<ResmanApiAuthResult> {
  const client = createUntypedAdminClient();

  // 1. Per-user / integration API token.
  const token = apiToken(request);
  if (token) {
    try {
      const subject = await authenticateAccessToken(client, token, "api_resman");
      if (subject) return { ok: true, kind: "token", subject };
    } catch {
      /* fall through to scanner auth / rejection */
    }
  }

  // 2. Scanner credential — the key identifies the device; ?scannerId is optional.
  if (hasScannerCredential(request)) {
    const scannerId = new URL(request.url).searchParams.get("scannerId");
    const scanner = await authenticateScanner(request, scannerId, client);
    if (scanner) return { ok: true, kind: "scanner" };
  }

  const allowed = await checkRateLimit({
    bucket: `resman-api:${requestSource(request)}`,
    maxAttempts: FAILED_ATTEMPT_MAX,
    windowMs: FAILED_ATTEMPT_WINDOW_MS,
    failClosed: true,
  });
  if (!allowed) {
    return { ok: false, response: NextResponse.json({ error: "Too many attempts" }, { status: 429 }) };
  }
  return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
}

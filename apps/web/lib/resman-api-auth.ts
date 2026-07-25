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
import { appRoleScopes, tokenForbiddenForResource } from "./app-role-capabilities";
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

export type StaffTokenResult =
  /** `kind` is always "token" — it stays on the shape so a result can still be
   *  handed to the actor helpers that accept a ResmanApiAuthResult. */
  | { ok: true; kind: "token"; subject: AccessTokenSubject }
  | { ok: false; response: NextResponse };

/**
 * Authenticate a STAFF-ONLY route: one of the bespoke back-office surfaces
 * (`/api/resman/manager/*`, `/api/resman/pm-tasks`) that the generic resource
 * router — and therefore its `scannerVisible` / scope authorization — never
 * touches.
 *
 * These routes historically checked only `auth.kind === "scanner"`. That reads
 * as "staff only", but it is not: a scoped app token is `kind: "token"`, so the
 * maintenance app's own credential sailed straight through to the rent ledger,
 * the delinquency list, lease terms, MLGW billing and the resident roster with
 * birthdates. Anyone holding a tech's phone held the back office.
 *
 * `capability` is checked against BOTH gates:
 *   - the role's capability set, so a scoped app role reaches only its own app's
 *     surface;
 *   - the token's explicit `scopes`, so a deliberately narrowed back-office
 *     token stays narrowed here too (empty `scopes` means unrestricted).
 */
export async function requireStaffToken(
  request: Request,
  capability: string,
): Promise<StaffTokenResult> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth;
  // A scanner is a gate device on a wall: a shared, physically-reachable
  // credential with no staff identity behind it.
  if (auth.kind === "scanner" || tokenForbiddenForResource(auth.subject, capability)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, kind: "token", subject: auth.subject };
}

// The authorization policy lives in its own pure module; re-exported so every
// caller keeps importing authentication and authorization from one place.
export { appRoleScopes, tokenForbiddenForResource };

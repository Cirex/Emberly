/**
 * Bearer-token auth for the read-only staff MCP server (/api/mcp).
 *
 * Delegates to the unified access-token store (kind='mcp'). A request must carry
 * `Authorization: Bearer <token>`; the token is resolved to its subject (an
 * admin user), and every tool call is attributed via the access-token audit log.
 * Invalid attempts are rate-limited per source. Fails closed.
 */
import { authenticateAccessToken, type AccessTokenSubject } from "../access-tokens";
import { requestSource } from "../http";
import { checkRateLimit } from "../rate-limit";
import { createUntypedAdminClient } from "../supabase/admin";
import type { UntypedSupabase } from "../supabase/types";

/** The authenticated MCP caller (an access-token subject of kind 'mcp'). */
export type McpStaff = AccessTokenSubject;

export type McpAuthResult =
  | { ok: true; staff: McpStaff; client: UntypedSupabase }
  | { ok: false; status: number; error: string };

const FAILED_ATTEMPT_MAX = 10;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function bearerToken(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function authenticateMcp(request: Request): Promise<McpAuthResult> {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: "Missing bearer token" };

  const client = createUntypedAdminClient();
  let subject: McpStaff | null;
  try {
    subject = await authenticateAccessToken(client, token, "mcp");
  } catch {
    return { ok: false, status: 500, error: "Auth lookup failed" };
  }

  if (!subject) {
    const allowed = await checkRateLimit({
      bucket: `mcp-token:${requestSource(request)}`,
      maxAttempts: FAILED_ATTEMPT_MAX,
      windowMs: FAILED_ATTEMPT_WINDOW_MS,
    });
    if (!allowed) return { ok: false, status: 429, error: "Too many attempts" };
    return { ok: false, status: 401, error: "Invalid or revoked token" };
  }

  return { ok: true, staff: subject, client };
}

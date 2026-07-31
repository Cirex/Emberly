/**
 * Unified access-token store for the MCP server and the private ResMan API.
 *
 * One `access_tokens` table backs both token kinds ('mcp', 'api_resman') and
 * both owner types ('admin_user', 'scanner'). Only the SHA-256 hash is stored;
 * the plaintext is returned once at mint time. Token use is audited to
 * access_token_audit_log for attribution.
 */
import { createHash, randomBytes } from "node:crypto";
import type { UntypedSupabase } from "./supabase/types";

export type TokenKind = "mcp" | "api_resman";
export type SubjectType = "admin_user" | "scanner";

const PREFIX: Record<TokenKind, string> = { mcp: "emcp", api_resman: "eapi" };

export interface AccessTokenSubject {
  tokenId: string;
  kind: TokenKind;
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  role: string;
  /**
   * Resource-name allowlist. EMPTY GRANTS NOTHING on the MCP surface; `["*"]`
   * is how you ask for everything. (The REST surface additionally gates on
   * `role` — see tokenForbiddenForResource.)
   */
  scopes: string[];
}

export interface AccessTokenSummary {
  id: string;
  kind: TokenKind;
  subject_type: SubjectType;
  subject_id: string;
  label: string;
  role: string;
  token_prefix: string;
  scopes: string[];
  active: boolean;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface MintedToken {
  id: string;
  token: string;
  tokenPrefix: string;
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAccessToken(kind: TokenKind): {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
} {
  const token = `${PREFIX[kind]}_${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: hashAccessToken(token), tokenPrefix: token.slice(0, 13) };
}

export interface MintAccessTokenInput {
  kind: TokenKind;
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  role?: string;
  scopes?: string[];
}

export async function mintAccessToken(
  client: UntypedSupabase,
  input: MintAccessTokenInput,
): Promise<MintedToken> {
  const { token, tokenHash, tokenPrefix } = generateAccessToken(input.kind);
  const { data, error } = await client
    .from("access_tokens")
    .insert({
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      kind: input.kind,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      label: input.label,
      role: input.role ?? "staff",
      scopes: input.scopes ?? [],
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: (data as { id: string }).id, token, tokenPrefix };
}

/**
 * Resolve a bearer token of a given kind to its subject, or null when missing /
 * inactive / revoked / wrong kind. Bumps last_used_at (best-effort).
 */
export async function authenticateAccessToken(
  client: UntypedSupabase,
  rawToken: string,
  kind: TokenKind,
): Promise<AccessTokenSubject | null> {
  const { data, error } = await client
    .from("access_tokens")
    .select("id, kind, subject_type, subject_id, label, role, scopes, active, revoked_at")
    .eq("token_hash", hashAccessToken(rawToken))
    .eq("kind", kind)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const row = data as {
    id: string;
    kind: TokenKind;
    subject_type: SubjectType;
    subject_id: string;
    label: string;
    role: string;
    scopes: unknown;
    active: boolean;
    revoked_at: string | null;
  } | null;
  if (!row || row.active !== true || row.revoked_at !== null) return null;

  // Best-effort last-used bump. supabase-js query builders are lazy PromiseLikes
  // — a bare `void builder` never dispatches the request, so this must be
  // `.then()`-ed (or awaited) to actually fire. Errors are swallowed; a failed
  // audit bump must never fail authentication.
  void client
    .from("access_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(
      () => {},
      () => {},
    );

  return {
    tokenId: row.id,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    label: row.label,
    role: row.role,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
  };
}

export async function listAccessTokens(
  client: UntypedSupabase,
  filter: { kind?: TokenKind; subjectType?: SubjectType; subjectId?: string } = {},
): Promise<AccessTokenSummary[]> {
  let query = client
    .from("access_tokens")
    .select(
      "id, kind, subject_type, subject_id, label, role, token_prefix, scopes, active, last_used_at, created_at, revoked_at",
    )
    .order("created_at", { ascending: false });
  if (filter.kind) query = query.eq("kind", filter.kind);
  if (filter.subjectType) query = query.eq("subject_type", filter.subjectType);
  if (filter.subjectId) query = query.eq("subject_id", filter.subjectId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as AccessTokenSummary[];
}

export async function revokeAccessToken(client: UntypedSupabase, id: string): Promise<boolean> {
  const { data, error } = await client
    .from("access_tokens")
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

export interface TokenAuditEntry {
  tool: string;
  resource?: string;
  args?: unknown;
  ok: boolean;
  error?: string;
}

/**
 * Argument keys carrying CALLER-SUPPLIED FREE TEXT, which the audit log must
 * never store verbatim.
 *
 * Ids, filter values and column names are all drawn from a fixed vocabulary and
 * are the point of the audit trail — they record which rows a token touched.
 * A search term is different in kind: it is typed by a human, it is matched
 * against names, and `{"resource":"residents","search":"hernandez"}` puts a
 * resident's surname in a log table nobody classifies as holding PII, forever.
 *
 * Substring search shipped in the same change that made this reachable, so this
 * redaction is part of that feature, not a later cleanup.
 */
const REDACTED_ARG_KEYS = new Set(["search", "q"]);

/** Depth ceiling — arguments are shallow, and a cycle must not hang the logger. */
const REDACT_MAX_DEPTH = 6;

/**
 * Replace a free-text argument with its shape: how long it was, and a short
 * digest so the SAME term is recognisably the same across calls.
 *
 * That keeps the two things an audit trail actually needs — "this token ran a
 * search" and "it ran the same search eleven times" — without keeping the term.
 * The digest is not a reversible record: an 8-hex prefix over an unbounded input
 * space confirms a guess you already hold, it does not yield the value.
 */
function redactFreeText(value: unknown): unknown {
  if (typeof value !== "string") return value === undefined ? undefined : "[redacted]";
  return {
    redacted: true,
    length: value.length,
    digest: createHash("sha256").update(value).digest("hex").slice(0, 8),
  };
}

/** Recursively redact free-text argument values. Exported for tests. */
export function redactAuditArgs(args: unknown, depth = 0): unknown {
  if (args === null || typeof args !== "object") return args;
  if (depth >= REDACT_MAX_DEPTH) return "[truncated]";
  if (Array.isArray(args)) return args.map((item) => redactAuditArgs(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = REDACTED_ARG_KEYS.has(key) ? redactFreeText(value) : redactAuditArgs(value, depth + 1);
  }
  return out;
}

/** Record one token use for attribution. Best-effort — never throws. */
export async function logAccessTokenUse(
  client: UntypedSupabase,
  subject: AccessTokenSubject,
  entry: TokenAuditEntry,
): Promise<void> {
  try {
    await client.from("access_token_audit_log").insert({
      token_id: subject.tokenId,
      subject_type: subject.subjectType,
      subject_id: subject.subjectId,
      label: subject.label,
      kind: subject.kind,
      tool: entry.tool,
      resource: entry.resource ?? "",
      // Redacted HERE rather than at the call site, so no future caller can
      // forget: everything that reaches the audit table goes through this.
      arguments: entry.args === undefined ? null : redactAuditArgs(entry.args),
      ok: entry.ok,
      error: entry.error ?? "",
    });
  } catch {
    /* audit is best-effort */
  }
}

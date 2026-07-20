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
  /** Resource-name allowlist; empty means all resources. */
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
      arguments: entry.args ?? null,
      ok: entry.ok,
      error: entry.error ?? "",
    });
  } catch {
    /* audit is best-effort */
  }
}

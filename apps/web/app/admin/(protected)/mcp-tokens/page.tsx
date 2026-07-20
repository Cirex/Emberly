import { listAccessTokens } from "@/lib/access-tokens";
import { RESMAN_RESOURCES } from "@/lib/resman-resources";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import { McpTokensClient, type McpTokenSummary } from "./mcp-tokens-client";

export const dynamic = "force-dynamic";

export default async function McpTokensPage() {
  let tokens: McpTokenSummary[] = [];
  let initialError = "";
  try {
    const client = createAdminClient() as unknown as UntypedSupabase;
    const rows = await listAccessTokens(client, { subjectType: "admin_user" });
    tokens = rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      staff_id: t.subject_id,
      staff_name: t.label,
      role: t.role,
      token_prefix: t.token_prefix,
      scopes: t.scopes,
      active: t.active,
      last_used_at: t.last_used_at,
      created_at: t.created_at,
      revoked_at: t.revoked_at,
    }));
  } catch (error) {
    console.error("[admin/mcp-tokens page] Failed to load tokens:", error);
    initialError = "Failed to load MCP tokens.";
  }

  return (
    <McpTokensClient
      initialTokens={tokens}
      resources={RESMAN_RESOURCES.map((r) => r.name)}
      initialError={initialError}
    />
  );
}

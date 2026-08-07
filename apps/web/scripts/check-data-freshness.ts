/**
 * Call the MCP server's `data_freshness` tool in-process and print its report.
 *
 * Runs the REAL tool code (lib/mcp/server.ts → handleMcpMessage → tools/call),
 * not a reimplementation of its queries, so what it prints is what a staff MCP
 * client would see. Read-only apart from the tool call's own audit-log row.
 *
 *   cd apps/web && bun --env-file=.env.production run scripts/check-data-freshness.ts [staleAfterHours]
 */
import { createClient } from "@supabase/supabase-js";

import type { McpStaff } from "@/lib/mcp/auth";
import { handleMcpMessage } from "@/lib/mcp/server";
import type { UntypedSupabase } from "@/lib/supabase/types";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as unknown as UntypedSupabase;

// A local, clearly-labelled subject. `["*"]` so the report covers every
// resource; the label is what lands in the audit log for this call.
const staff: McpStaff = {
  tokenId: "local-freshness-check",
  kind: "mcp",
  subjectType: "admin_user",
  subjectId: "local-freshness-check",
  label: "scripts/check-data-freshness.ts",
  role: "admin",
  scopes: ["*"],
};

const staleAfterHours = process.argv[2] ? Number(process.argv[2]) : undefined;

const response = await handleMcpMessage(
  {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "data_freshness",
      arguments: staleAfterHours === undefined ? {} : { stale_after_hours: staleAfterHours },
    },
  },
  { staff, client },
);

const result = (response as { result?: { content?: Array<{ text?: string }>; isError?: boolean } } | null)?.result;
const text = result?.content?.[0]?.text ?? JSON.stringify(response);
if (result?.isError) {
  console.error(text);
  process.exit(1);
}
console.log(JSON.stringify(JSON.parse(text), null, 2));

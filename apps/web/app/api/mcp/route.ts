/**
 * Read-only staff MCP server endpoint (Streamable-HTTP style, stateless).
 *
 * POST /api/mcp with a JSON-RPC message (or batch). Gated by a per-staff bearer
 * token (Authorization: Bearer <emcp_…>) resolved against access_tokens (kind
 * `mcp`); each tool call is attributed in access_token_audit_log. Read-only —
 * the tools only list/get the ResMan/MLGW mirror data through the query engine.
 */
import { NextResponse } from "next/server";
import { authenticateMcp } from "@/lib/mcp/auth";
import { handleMcpMessage } from "@/lib/mcp/server";

// node:crypto (token hashing) + service-role admin client require the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateMcp(request);
  if (!auth.ok) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: auth.error } },
      { status: auth.status, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  const ctx = { staff: auth.staff, client: auth.client };

  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((message) => handleMcpMessage(message ?? {}, ctx)))
    ).filter((r): r is Record<string, unknown> => r !== null);
    if (responses.length === 0) return new Response(null, { status: 202 });
    return NextResponse.json(responses);
  }

  const response = await handleMcpMessage((body ?? {}) as Record<string, unknown>, ctx);
  if (response === null) return new Response(null, { status: 202 });
  return NextResponse.json(response);
}

export function GET(): Response {
  return NextResponse.json(
    { error: "This MCP endpoint accepts JSON-RPC over POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

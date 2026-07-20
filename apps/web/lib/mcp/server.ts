/**
 * Read-only staff MCP server for the ResMan/MLGW mirror data.
 *
 * Exposes three tools over the existing query engine (lib/resman-api):
 *   - list_resources   — catalog of resources, their filters, and exposed columns
 *   - query_resource   — list rows with equality filters + pagination
 *   - get_resource     — fetch one row by id
 *
 * The MCP JSON-RPC methods (initialize / tools/list / tools/call / ping /
 * notifications) are dispatched directly — the official SDK's Streamable-HTTP
 * transport is built for Node req/res, whereas Next.js route handlers use the
 * Web Request/Response model, so a stateless per-request dispatch is cleaner.
 * Every tool call is scope-checked against the staff's allowlist and audited.
 */
import { logAccessTokenUse } from "../access-tokens";
import { getResource, listResource } from "../resman-api";
import { RESMAN_RESOURCES, type ResmanResource } from "../resman-resources";
import type { UntypedSupabase } from "../supabase/types";
import type { McpStaff } from "./auth";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "emberly-resman-mcp", version: "0.1.0" } as const;

const RESOURCE_BY_NAME = new Map(RESMAN_RESOURCES.map((r) => [r.name, r]));
const RESOURCE_NAMES = RESMAN_RESOURCES.map((r) => r.name);

class McpToolError extends Error {}

interface ToolCtx {
  staff: McpStaff;
  client: UntypedSupabase;
}

interface ToolResult {
  text: string;
  resource: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
}

function inScope(staff: McpStaff, name: string): boolean {
  return staff.scopes.length === 0 || staff.scopes.includes(name);
}

function resolveResource(staff: McpStaff, name: string): ResmanResource {
  const resource = RESOURCE_BY_NAME.get(name);
  if (!resource) throw new McpToolError(`Unknown resource "${name}". Call list_resources for valid names.`);
  if (!inScope(staff, name)) throw new McpToolError(`Not authorized for resource "${name}".`);
  return resource;
}

const TOOLS: McpTool[] = [
  {
    name: "list_resources",
    description:
      "List the available ResMan/MLGW data resources, their filterable parameters, and the columns each exposes. Call this first to discover what can be queried.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const resources = RESMAN_RESOURCES.filter((r) => inScope(ctx.staff, r.name)).map((r) => ({
        resource: r.name,
        table: r.table,
        id_column: r.idColumn,
        filters: Object.keys(r.filters),
        columns: r.publicColumns,
      }));
      return { resource: "", text: JSON.stringify({ resources }, null, 2) };
    },
  },
  {
    name: "query_resource",
    description:
      "List rows from a resource with optional equality filters and pagination. Read-only. Returns { data, pagination }.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Resource name (see list_resources)." },
        filters: {
          type: "object",
          description: "Equality filters keyed by the resource's filter parameters (see list_resources).",
          additionalProperties: { type: ["string", "boolean"] },
        },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max rows (default 50)." },
        offset: { type: "integer", minimum: 0, description: "Row offset for pagination (default 0)." },
      },
      required: ["resource"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const resource = resolveResource(ctx.staff, String(args.resource ?? ""));
      const params = new URLSearchParams();
      const filters = (args.filters ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.offset !== undefined) params.set("offset", String(args.offset));
      const result = await listResource(resource, params, ctx.client);
      return { resource: resource.name, text: JSON.stringify(result, null, 2) };
    },
  },
  {
    name: "get_resource",
    description: "Fetch a single row from a resource by its id. Returns { data } or { data: null } when not found.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Resource name (see list_resources)." },
        id: { type: "string", description: "The resource's id-column value." },
      },
      required: ["resource", "id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const resource = resolveResource(ctx.staff, String(args.resource ?? ""));
      const row = await getResource(resource, String(args.id ?? ""), ctx.client);
      return { resource: resource.name, text: JSON.stringify({ data: row }, null, 2) };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (no id) that require no reply.
 */
export async function handleMcpMessage(
  message: JsonRpcMessage,
  ctx: ToolCtx,
): Promise<Record<string, unknown> | null> {
  const id = message.id ?? null;
  const method = message.method;
  const params = message.params ?? {};
  const reply = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return reply({
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return fail(-32602, `Unknown tool "${name}"`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const { text, resource } = await tool.run(args, ctx);
        void logAccessTokenUse(ctx.client, ctx.staff, { tool: name, resource, args, ok: true });
        return reply({ content: [{ type: "text", text }] });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void logAccessTokenUse(ctx.client, ctx.staff, { tool: name, args, ok: false, error: msg });
        // Tool failures are returned as isError results, not protocol errors.
        return reply({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });
      }
    }
    default:
      if (id === null) return null; // unknown notification — ignore
      if (typeof method === "string" && method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}

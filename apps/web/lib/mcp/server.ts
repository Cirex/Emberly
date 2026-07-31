/**
 * Read-only staff MCP server for the ResMan/MLGW mirror data.
 *
 * Six tools over the existing query engine (lib/resman-api):
 *   - list_resources     — catalog: what exists and what each can do
 *   - describe_resource  — one resource in depth: columns, capabilities, the
 *                          VALUES its groupable columns actually hold, row
 *                          count, and data freshness
 *   - query_resource     — rows, with equality filters, ranges, substring
 *                          search, sort, projection and pagination
 *   - aggregate_resource — group-and-measure, so counting questions cost one
 *                          call instead of paging the table into the model
 *   - get_resource       — one row by id
 *   - related_resource   — walk a DECLARED relation to another resource
 *
 * The design rule throughout is that a caller names a CAPABILITY, never a raw
 * column or expression: every searchable, groupable, sortable and joinable
 * column is declared on the resource (lib/resman-resources.ts) and anything
 * absent from those lists is unreachable however the request is phrased. That
 * is what lets this be genuinely expressive without becoming arbitrary SQL over
 * resident data.
 *
 * The MCP JSON-RPC methods (initialize / tools/list / tools/call / ping /
 * notifications) are dispatched directly — the official SDK's Streamable-HTTP
 * transport is built for Node req/res, whereas Next.js route handlers use the
 * Web Request/Response model, so a stateless per-request dispatch is cleaner.
 * Every tool call is scope-checked against the staff's allowlist and audited.
 */
import { logAccessTokenUse } from "../access-tokens";
import { aggregateResource, describeResourceData, getResource, listResource } from "../resman-api";
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

/**
 * Wildcard scope. Explicit by design — see `inScope`.
 */
const SCOPE_ALL = "*";

/**
 * Is this staff token allowed to touch this resource?
 *
 * An EMPTY scope list grants NOTHING. It previously granted everything, which
 * made the one fail-open path in an otherwise fail-closed design: tokens are
 * minted with `scopes: input.scopes ?? []` (lib/access-tokens.ts), so a token
 * created without explicitly naming its scopes silently received all thirteen
 * resources — residents, transactions and entry logs included. Full access is
 * now something you ask for by writing `["*"]`, not something you get by
 * forgetting.
 */
function inScope(staff: McpStaff, name: string): boolean {
  return staff.scopes.includes(SCOPE_ALL) || staff.scopes.includes(name);
}

function resolveResource(staff: McpStaff, name: string): ResmanResource {
  const resource = RESOURCE_BY_NAME.get(name);
  if (!resource) throw new McpToolError(`Unknown resource "${name}". Call list_resources for valid names.`);
  if (!inScope(staff, name)) throw new McpToolError(`Not authorized for resource "${name}".`);
  return resource;
}

/**
 * Compact JSON. The previous `JSON.stringify(x, null, 2)` spent roughly a third
 * of every response on indentation, which on a 200-row page is real context the
 * caller then cannot spend on reasoning.
 */
function json(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Flatten a tool's structured arguments into the query string the REST engine
 * already understands, so both doors run exactly one implementation of
 * filtering, ranging, searching and paging.
 */
function toParams(args: Record<string, unknown>, resource: ResmanResource): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries((args.filters ?? {}) as Record<string, unknown>)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  for (const [key, value] of Object.entries((args.ranges ?? {}) as Record<string, unknown>)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  if (typeof args.search === "string" && args.search.trim()) params.set("q", args.search.trim());
  if (Array.isArray(args.columns) && args.columns.length > 0) {
    params.set("columns", args.columns.map(String).join(","));
  }
  if (typeof args.sort === "string" && resource.sortable.includes(args.sort)) params.set("sort", args.sort);
  if (typeof args.dir === "string") params.set("dir", args.dir);
  if (args.limit !== undefined) params.set("limit", String(args.limit));
  if (args.offset !== undefined) params.set("offset", String(args.offset));
  return params;
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
        id_column: r.idColumn,
        filters: Object.keys(r.filters),
        ranges: Object.keys(r.ranges),
        searchable: r.searchable,
        groupable: r.groupable,
        measures: r.measures,
        relations: r.relations.map((rel) => `${rel.name} -> ${rel.resource} (${rel.kind})`),
      }));
      // Columns are deliberately NOT included here — thirteen resources' worth
      // of column lists is a large payload to spend before knowing which one
      // matters. describe_resource carries them, one resource at a time.
      return {
        resource: "",
        text: json({
          resources,
          next: "Call describe_resource before filtering or grouping: it reports the values each column actually holds, so a filter can be written rather than guessed.",
        }),
      };
    },
  },
  {
    name: "describe_resource",
    description:
      "Describe one resource in depth: its columns, every filter/range/search/group/measure it supports, the DISTINCT VALUES its groupable columns actually contain, total row count, and when the data was last synced. Call this before writing filters — it is how you learn that occupancy_status is 'Occupied'/'Vacant'/'Notice' rather than guessing.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Resource name (see list_resources)." },
      },
      required: ["resource"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const resource = resolveResource(ctx.staff, String(args.resource ?? ""));
      const profile = await describeResourceData(resource, ctx.client);
      return {
        resource: resource.name,
        text: json({
          resource: resource.name,
          id_column: resource.idColumn,
          columns: resource.publicColumns,
          capabilities: {
            filters: resource.filters,
            ranges: Object.keys(resource.ranges).map((p) => `${p}_from / ${p}_to`),
            searchable: resource.searchable,
            groupable: resource.groupable,
            measures: resource.measures,
            sortable: resource.sortable,
          },
          relations: resource.relations,
          row_count: profile.row_count,
          last_synced_at: profile.last_synced_at,
          distinct_values: profile.distinct_values,
          notes: [
            profile.sampled > 0 && profile.sampled < profile.row_count
              ? `distinct_values sampled ${profile.sampled} of ${profile.row_count} rows — indicative, not exhaustive.`
              : null,
            "last_synced_at is when the scraper last saw these rows, not when they last changed.",
          ].filter(Boolean),
        }),
      };
    },
  },
  {
    name: "query_resource",
    description:
      "List rows from a resource. Supports equality filters, inclusive ranges (<param>_from / <param>_to), substring search across the resource's searchable columns, sorting, and a column projection. Read-only. Returns { data, pagination }. To COUNT rather than list, use aggregate_resource — it is exact and transfers no rows.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Resource name (see list_resources)." },
        filters: {
          type: "object",
          description: "Equality filters keyed by the resource's filter parameters (see describe_resource).",
          additionalProperties: { type: ["string", "boolean"] },
        },
        ranges: {
          type: "object",
          description:
            "Inclusive bounds keyed as '<param>_from' / '<param>_to', e.g. { reported_from: '2026-01-01' }. See describe_resource for the available range params.",
          additionalProperties: { type: ["string", "number"] },
        },
        search: {
          type: "string",
          description:
            "Substring match (case-insensitive) across the resource's searchable columns. Minimum 2 characters.",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Return only these columns. Intersected with the resource's public columns.",
        },
        sort: { type: "string", description: "Column to sort by (must be in the resource's sortable list)." },
        dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default asc)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max rows (default 50)." },
        offset: { type: "integer", minimum: 0, description: "Row offset for pagination (default 0)." },
      },
      required: ["resource"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const resource = resolveResource(ctx.staff, String(args.resource ?? ""));
      const params = toParams(args, resource);
      const result = await listResource(resource, params, ctx.client);
      return { resource: resource.name, text: json(result) };
    },
  },
  {
    name: "aggregate_resource",
    description:
      "Group and measure over a resource — 'how many units by occupancy_status', 'total balance by building'. Honours the same filters, ranges and search as query_resource. count is EXACT and reads no rows; sum/avg/min/max scan up to 20,000 rows and set truncated:true if they hit that ceiling. Prefer this over paging rows and counting them yourself.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Resource name." },
        group_by: {
          type: "string",
          description:
            "Column to group by — must be in the resource's groupable list (see describe_resource). Omit for a single total.",
        },
        metric: {
          type: "string",
          enum: ["count", "sum", "avg", "min", "max"],
          description: "Aggregate to compute (default count).",
        },
        measure: { type: "string", description: "Numeric column for sum/avg/min/max. Required unless metric is count." },
        filters: { type: "object", additionalProperties: { type: ["string", "boolean"] } },
        ranges: { type: "object", additionalProperties: { type: ["string", "number"] } },
        search: { type: "string" },
      },
      required: ["resource"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const resource = resolveResource(ctx.staff, String(args.resource ?? ""));
      const metric = (args.metric ? String(args.metric) : "count") as
        | "count" | "sum" | "avg" | "min" | "max";
      const groupBy = args.group_by ? String(args.group_by) : null;
      const measure = args.measure ? String(args.measure) : null;

      if (groupBy && !resource.groupable.includes(groupBy)) {
        throw new McpToolError(
          `"${groupBy}" is not groupable on ${resource.name}. Groupable: ${resource.groupable.join(", ") || "(none)"}.`,
        );
      }
      if (metric !== "count") {
        if (!measure) throw new McpToolError(`metric "${metric}" requires a measure column.`);
        if (!resource.measures.includes(measure)) {
          throw new McpToolError(
            `"${measure}" is not a measure on ${resource.name}. Measures: ${resource.measures.join(", ") || "(none)"}.`,
          );
        }
      }

      // A count grouping needs the domain of the group column. Learn it from
      // the data rather than asking the caller — an omitted value would show up
      // as a missing bucket, which reads like a real zero.
      let groupValues: (string | null)[] = [];
      if (groupBy) {
        const profile = await describeResourceData(resource, ctx.client);
        groupValues = (profile.distinct_values[groupBy] ?? []).map((d) => d.value);
        if (groupValues.length === 0) groupValues = [null];
      }

      const result = await aggregateResource(
        resource,
        toParams(args, resource),
        { groupBy, groupValues, metric, measure },
        ctx.client,
      );
      return { resource: resource.name, text: json(result) };
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
      return { resource: resource.name, text: json({ data: row }) };
    },
  },
  {
    name: "related_resource",
    description:
      "Follow a declared relation from one row to another resource — a unit's leases, a lease's residents, a unit's work orders. Call describe_resource to see what relations a resource has. Only declared hops are reachable; arbitrary joins are not.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Starting resource." },
        id: { type: "string", description: "Id of the starting row." },
        relation: { type: "string", description: "Relation name (see describe_resource)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max related rows (default 50)." },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["resource", "id", "relation"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const from = resolveResource(ctx.staff, String(args.resource ?? ""));
      const name = String(args.relation ?? "");
      const relation = from.relations.find((r) => r.name === name);
      if (!relation) {
        throw new McpToolError(
          `Unknown relation "${name}" on ${from.name}. Available: ${from.relations.map((r) => r.name).join(", ") || "(none)"}.`,
        );
      }
      // The TARGET is scope-checked independently: reaching residents via a
      // lease must not bypass a token that lacks the residents scope.
      const target = resolveResource(ctx.staff, relation.resource);

      const source = await getResource(from, String(args.id ?? ""), ctx.client);
      if (!source) return { resource: from.name, text: json({ data: null, reason: "source row not found" }) };

      const key = source[relation.localColumn];
      if (key === null || key === undefined || key === "") {
        return {
          resource: target.name,
          text: json({ data: relation.kind === "one" ? null : [], reason: `${relation.localColumn} is empty on the source row` }),
        };
      }

      if (relation.kind === "one") {
        const row = await getResource(target, String(key), ctx.client);
        return { resource: target.name, text: json({ relation: name, data: row, note: relation.note }) };
      }

      const params = new URLSearchParams();
      // Match on the foreign column via the target's own filter map where one
      // exists, so the hop reuses the resource's declared, indexed filters.
      const param = Object.entries(target.filters).find(([, col]) => col === relation.foreignColumn)?.[0];
      if (!param) {
        throw new McpToolError(
          `Relation "${name}" targets ${target.name}.${relation.foreignColumn}, which that resource does not expose as a filter.`,
        );
      }
      params.set(param, String(key));
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.offset !== undefined) params.set("offset", String(args.offset));
      const result = await listResource(target, params, ctx.client);
      return { resource: target.name, text: json({ relation: name, note: relation.note, ...result }) };
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

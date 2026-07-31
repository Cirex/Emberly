/**
 * Read-only staff MCP server for the ResMan/MLGW mirror data.
 *
 * Nine tools over the existing query engine (lib/resman-api):
 *   - list_resources     — catalog: what exists and what each can do
 *   - describe_resource  — one resource in depth: columns, capabilities, the
 *                          VALUES its groupable columns actually hold, row
 *                          count, and data freshness
 *   - query_resource     — rows, with equality filters, ranges, substring
 *                          search, sort, projection and pagination
 *   - aggregate_resource — group-and-measure, optionally bucketed over a
 *                          calendar interval, so counting and trend questions
 *                          cost one call instead of paging the table
 *   - aggregate_related  — group one resource by ANOTHER's attribute
 *   - get_resource       — one row by id
 *   - related_resource   — walk a DECLARED relation to another resource
 *   - detect_anomalies   — which entities moved most against THEIR OWN history
 *   - data_freshness     — how current each resource is, and which stopped
 *
 * Plus two MCP primitives beyond tools: `prompts` (canned analyses that encode
 * the traps in this data) and `resources` (a scope-filtered schema catalog and
 * a data-traps sheet, attachable as context instead of a round trip).
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
import { detectAnomalies, MIN_BASELINE_PERIODS, toAnomalyInputs } from "../anomalies";
import { checkRateLimit } from "../rate-limit";
import {
  DEFAULT_TIMEZONE,
  PERIOD_INTERVALS,
  type PeriodInterval,
} from "../period-buckets";
import {
  aggregateRelated,
  aggregateResource,
  describeResourceData,
  getResource,
  listResource,
  scanForSeries,
  type PeriodSpec,
} from "../resman-api";
import { RESMAN_RESOURCES, type ResmanResource } from "../resman-resources";
import type { UntypedSupabase } from "../supabase/types";
import type { McpStaff } from "./auth";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "emberly-resman-mcp", version: "0.2.0" } as const;

/**
 * Per-token call budget.
 *
 * Failed AUTH was already rate-limited; successful calls were not, so a valid
 * token could page the mirror as fast as it could ask. That matters more now
 * than it did: `aggregate_resource` issues one query per group and
 * `aggregate_related` scans both sides of a hop, so a single tool call is no
 * longer a single database round trip.
 *
 * Sized to be invisible to an agent doing real work and to stop a runaway loop
 * within a minute or two, not to meter usage.
 */
const CALL_BUDGET_MAX = 600;
const CALL_BUDGET_WINDOW_MS = 15 * 60 * 1000;

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
 * Distinguish "your filters matched nothing" from "this table has never held a
 * row", which look identical in an empty response and mean opposite things.
 *
 * The gate log is the live example: `entry_logs` is empty, so "who came through
 * last night" returns `[]` and reads as "nobody came through" when the truth is
 * that the scanners have never been used. Costs one HEAD count, and only when
 * the result was empty anyway.
 */
async function emptinessNote(
  resource: ResmanResource,
  ctx: ToolCtx,
): Promise<string | null> {
  const { count, error } = await ctx.client
    .from(resource.table)
    .select(resource.idColumn, { count: "exact", head: true });
  if (error || count === null) return null;
  return count === 0
    ? `The ${resource.name} resource is EMPTY — 0 rows in total, before any filter. This is not a filtered-out result: nothing has ever been recorded here. Say so rather than reporting a zero.`
    : null;
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

/**
 * Validate the `period` argument against the resource's declared period
 * columns. Same rule as everywhere else: the caller names a declared capability,
 * never an arbitrary column, so no date column becomes bucketable by accident.
 */
function resolvePeriodArg(resource: ResmanResource, raw: unknown): PeriodSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const arg = raw as Record<string, unknown>;
  const name = String(arg.column ?? "");
  const declared = resource.periods[name];
  if (!declared) {
    const available = Object.keys(resource.periods).join(", ") || "(none)";
    throw new McpToolError(`"${name}" is not a period column on ${resource.name}. Available: ${available}.`);
  }
  const interval = arg.interval ? String(arg.interval) : "month";
  if (!PERIOD_INTERVALS.includes(interval as PeriodInterval)) {
    throw new McpToolError(`Unknown interval "${interval}". Use one of: ${PERIOD_INTERVALS.join(", ")}.`);
  }
  const timezone = arg.timezone ? String(arg.timezone) : DEFAULT_TIMEZONE;
  // Reject an unknown zone here rather than letting Intl throw mid-aggregate.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new McpToolError(`Unknown timezone "${timezone}".`);
  }
  return { column: declared.column, kind: declared.kind, interval: interval as PeriodInterval, timezone };
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
        periods: Object.keys(r.periods),
        entities: r.entities,
        has_caveats: r.notes.length > 0,
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
            periods: Object.entries(resource.periods).map(([name, p]) => ({
              column: name, kind: p.kind, intervals: PERIOD_INTERVALS,
            })),
            entities: resource.entities,
          },
          relations: resource.relations,
          // Caveats first: a note that arrives after the number has already
          // been read has not done its job.
          notes_before_you_report: resource.notes,
          row_count: profile.row_count,
          last_synced_at: profile.last_synced_at,
          distinct_values: profile.distinct_values,
          notes: [
            profile.sampled > 0 && profile.sampled < profile.row_count
              ? `distinct_values sampled ${profile.sampled} of ${profile.row_count} rows — indicative, not exhaustive.`
              : null,
            "last_synced_at is when the scraper last saw these rows, not when they last changed.",
            profile.domain_complete
              ? null
              : "distinct_values are from a sample, so a rare value may be missing. A count aggregate reconciles against the true total and reports any shortfall as an \"(other)\" bucket.",
            profile.row_count === 0
              ? "This resource is EMPTY — 0 rows. A query against it returns nothing because nothing has ever been recorded, not because the filters excluded it."
              : null,
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
      const note = result.data.length === 0 ? await emptinessNote(resource, ctx) : null;
      return { resource: resource.name, text: json(note ? { ...result, note } : result) };
    },
  },
  {
    name: "aggregate_resource",
    description:
      "Group and measure over a resource — 'how many units by occupancy_status', 'total balance by building', 'utility spend by month'. Honours the same filters, ranges and search as query_resource. Pass `period` to bucket over time (day/week/month/quarter/year) instead of, or as well as, a categorical group_by. count is EXACT and reads no rows; sum/avg/min/max scan up to 20,000 rows and set truncated:true if they hit that ceiling. Prefer this over paging rows and counting them yourself.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Resource name." },
        group_by: {
          type: "string",
          description:
            "Column to group by — must be in the resource's groupable list (see describe_resource). Omit for a single total.",
        },
        period: {
          type: "object",
          description:
            "Bucket over time. `column` must be one of the resource's period columns (see describe_resource). Combines with group_by to give a series per category.",
          properties: {
            column: { type: "string", description: "Period column name, e.g. 'bill_date', 'reported', 'entered'." },
            interval: { type: "string", enum: [...PERIOD_INTERVALS], description: "Bucket size (default month)." },
            timezone: {
              type: "string",
              description:
                "IANA zone for bucketing TIMESTAMP columns (default America/Chicago, the property's zone). Ignored for plain DATE columns, which have no timezone.",
            },
          },
          required: ["column"],
          additionalProperties: false,
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

      const period = resolvePeriodArg(resource, args.period);

      // The domain is no longer fetched here. Grouping happens in Postgres, so
      // the group set comes back exact; only the fallback path needs a domain,
      // and it learns one itself when it has to.
      const result = await aggregateResource(
        resource,
        toParams(args, resource),
        { groupBy, groupValues: [], metric, measure, period },
        ctx.client,
      );
      const notes = [
        result.engine === "scan" && groupBy && metric === "count"
          ? `Grouped in the application rather than in SQL (mcp_aggregate unavailable), so group values came from a sample of ${resource.name}. Anything the sample missed is counted in the "(other)" bucket rather than dropped.`
          : null,
        // "No bucket held anything" — not "no buckets came back". A grouped
        // count over an empty table returns one bucket of zero, which would
        // otherwise slip past this check and read as a real zero.
        result.buckets.every((b) => b.count === 0) ? await emptinessNote(resource, ctx) : null,
      ].filter(Boolean);
      return { resource: resource.name, text: json(notes.length ? { ...result, notes } : result) };
    },
  },
  {
    name: "aggregate_related",
    description:
      "Aggregate one resource GROUPED BY an attribute of a resource it is related to — 'total transaction charges by building', 'work orders by unit classification', 'utility spend by occupancy status'. Give the PARENT resource (whose column you group by), a declared 'many' relation, and a measure on the related resource. Filters/ranges/search apply to the PARENT. This reads rows on both sides and reports both scan caps: prefer aggregate_resource whenever the group column and the measure live on the same resource.",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          enum: RESOURCE_NAMES,
          description: "The PARENT resource — the one whose column you are grouping by (e.g. 'units').",
        },
        relation: {
          type: "string",
          description: "A declared 'many' relation on that resource (see describe_resource), e.g. 'transactions'.",
        },
        group_by: {
          type: "string",
          description: "Column on the PARENT resource to group by. Omit for a single total across the relation.",
        },
        metric: { type: "string", enum: ["count", "sum", "avg", "min", "max"], description: "Default count." },
        measure: {
          type: "string",
          description: "Numeric column on the RELATED resource. Required unless metric is count.",
        },
        filters: { type: "object", additionalProperties: { type: ["string", "boolean"] } },
        ranges: { type: "object", additionalProperties: { type: ["string", "number"] } },
        search: { type: "string" },
      },
      required: ["resource", "relation"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const parent = resolveResource(ctx.staff, String(args.resource ?? ""));
      const name = String(args.relation ?? "");
      const relation = parent.relations.find((r) => r.name === name);
      if (!relation) {
        throw new McpToolError(
          `Unknown relation "${name}" on ${parent.name}. Available: ${parent.relations.map((r) => r.name).join(", ") || "(none)"}.`,
        );
      }
      // Only the one-to-many direction makes sense here: the parent supplies the
      // grouping attribute and the related rows supply the measure. A "one" hop
      // would group the single target row by the many parents pointing at it,
      // which is the question asked backwards.
      if (relation.kind !== "many") {
        throw new McpToolError(
          `Relation "${name}" is a "one" hop. aggregate_related groups a parent's attribute over its MANY related rows — start from ${relation.resource} and use the inverse relation, or use aggregate_resource on ${parent.name} directly.`,
        );
      }
      const target = resolveResource(ctx.staff, relation.resource);

      const metric = (args.metric ? String(args.metric) : "count") as
        | "count" | "sum" | "avg" | "min" | "max";
      const groupBy = args.group_by ? String(args.group_by) : null;
      const measure = args.measure ? String(args.measure) : null;

      if (groupBy && !parent.groupable.includes(groupBy)) {
        throw new McpToolError(
          `"${groupBy}" is not groupable on ${parent.name}. Groupable: ${parent.groupable.join(", ") || "(none)"}.`,
        );
      }
      if (metric !== "count") {
        if (!measure) throw new McpToolError(`metric "${metric}" requires a measure column.`);
        // The measure belongs to the TARGET, so it is validated against the
        // target's allowlist — reaching a column through a join must not be a
        // way around the resource that owns it.
        if (!target.measures.includes(measure)) {
          throw new McpToolError(
            `"${measure}" is not a measure on ${target.name}. Measures: ${target.measures.join(", ") || "(none)"}.`,
          );
        }
      }

      const result = await aggregateRelated(
        parent,
        target,
        relation,
        toParams(args, parent),
        { groupBy, metric, measure },
        ctx.client,
      );
      return { resource: target.name, text: json(result) };
    },
  },
  {
    name: "detect_anomalies",
    description:
      "Find the entities whose latest period moved most against THEIR OWN history — 'which utility accounts spiked this month', 'which units' charges jumped'. Each entity is scored against its own baseline, never against other entities, so a large account is not permanently flagged for being large. Returns ranked outliers with the baseline that produced each score. This is triage for a human, not a verdict.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: RESOURCE_NAMES, description: "Resource holding the series." },
        entity: {
          type: "string",
          description: "Column identifying the subject (see describe_resource 'entities'), e.g. 'mlgw_account_id'.",
        },
        measure: { type: "string", description: "Numeric column to track. Must be one of the resource's measures." },
        period: {
          type: "object",
          properties: {
            column: { type: "string" },
            interval: { type: "string", enum: [...PERIOD_INTERVALS] },
            timezone: { type: "string" },
          },
          required: ["column"],
          additionalProperties: false,
        },
        focus_period: {
          type: "string",
          description: "Period label to score (e.g. '2026-06'). Defaults to the latest present in the data.",
        },
        min_baseline: {
          type: "integer", minimum: 2, maximum: 24,
          description: `Prior periods an entity needs before it can be scored (default ${MIN_BASELINE_PERIODS}).`,
        },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max anomalies returned (default 20)." },
        filters: { type: "object", additionalProperties: { type: ["string", "boolean"] } },
        ranges: { type: "object", additionalProperties: { type: ["string", "number"] } },
      },
      required: ["resource", "entity", "measure", "period"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const resource = resolveResource(ctx.staff, String(args.resource ?? ""));
      const entity = String(args.entity ?? "");
      const measure = String(args.measure ?? "");
      if (!resource.entities.includes(entity)) {
        throw new McpToolError(
          `"${entity}" is not an entity column on ${resource.name}. Available: ${resource.entities.join(", ") || "(none)"}.`,
        );
      }
      if (!resource.measures.includes(measure)) {
        throw new McpToolError(
          `"${measure}" is not a measure on ${resource.name}. Measures: ${resource.measures.join(", ") || "(none)"}.`,
        );
      }
      const period = resolvePeriodArg(resource, args.period);
      if (!period) throw new McpToolError("detect_anomalies requires a period.");

      const { rows, truncated } = await scanForSeries(
        resource,
        toParams(args, resource),
        [entity, period.column, measure],
        ctx.client,
      );
      const report = detectAnomalies(
        toAnomalyInputs(rows, {
          entityColumn: entity, periodColumn: period.column, measure,
          interval: period.interval, kind: period.kind, timezone: period.timezone,
        }),
        {
          limit: args.limit ? Number(args.limit) : undefined,
          minBaseline: args.min_baseline ? Number(args.min_baseline) : undefined,
          focusPeriod: args.focus_period ? String(args.focus_period) : undefined,
        },
      );
      if (truncated) {
        report.notes.unshift(
          "The scan hit its row cap, so some entities have INCOMPLETE history and their baselines are wrong. Narrow the range before trusting these scores.",
        );
      }
      return {
        resource: resource.name,
        text: json({ ...report, entity_column: entity, measure, interval: period.interval, scanned: rows.length, truncated }),
      };
    },
  },
  {
    name: "data_freshness",
    description:
      "Report how current each resource is: row count, when the scraper last saw it, when it last changed, and how far it lags the freshest resource. Use this before reporting any number that has to be current — it is how you catch a table that silently stopped syncing while its neighbours kept going.",
    inputSchema: {
      type: "object",
      properties: {
        stale_after_hours: {
          type: "number", minimum: 1,
          description: "Lag behind the freshest resource, in hours, at which a resource is flagged stale (default 24).",
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const staleAfter = args.stale_after_hours ? Number(args.stale_after_hours) : 24;
      const visible = RESMAN_RESOURCES.filter((r) => inScope(ctx.staff, r.name));

      const rows = await Promise.all(
        visible.map(async (r) => {
          const newest = async (column: string): Promise<string | null> => {
            if (!r.selectColumns.includes(column)) return null;
            const { data } = await ctx.client
              .from(r.table).select(column).not(column, "is", null)
              .order(column, { ascending: false }).limit(1);
            const value = (data as Record<string, unknown>[] | null)?.[0]?.[column];
            return value === null || value === undefined ? null : String(value);
          };
          const [countResult, syncedAt, updatedAt, createdAt] = await Promise.all([
            ctx.client.from(r.table).select(r.idColumn, { count: "exact", head: true }),
            newest("synced_at"),
            newest("updated_at"),
            newest("created_at"),
          ]);
          // Not every resource has synced_at — the first-party tables never do.
          // Falling back keeps them from showing as "unknown age" forever, and
          // the column used is reported so nobody reads a created_at as a sync.
          const [freshness, column] =
            syncedAt !== null ? [syncedAt, "synced_at"]
            : updatedAt !== null ? [updatedAt, "updated_at"]
            : createdAt !== null ? [createdAt, "created_at"]
            : [null, null];
          return {
            resource: r.name,
            row_count: (countResult as { count: number | null }).count ?? 0,
            last_synced_at: syncedAt,
            last_updated_at: updatedAt,
            freshness_from: column,
            freshness_at: freshness,
          };
        }),
      );

      // Staleness is RELATIVE. An absolute threshold flags everything after a
      // quiet weekend; lagging the freshest table is what actually indicates a
      // sync that stopped — which is how `units` sat frozen for twelve days
      // while work-orders kept updating, and nothing said so.
      const stamps = rows.map((r) => (r.freshness_at ? Date.parse(r.freshness_at) : NaN)).filter((n) => !Number.isNaN(n));
      const freshest = stamps.length > 0 ? Math.max(...stamps) : null;
      const enriched = rows.map((r) => {
        const ms = r.freshness_at ? Date.parse(r.freshness_at) : NaN;
        const lagHours = freshest !== null && !Number.isNaN(ms) ? (freshest - ms) / 3_600_000 : null;
        return {
          ...r,
          lag_hours: lagHours === null ? null : Math.round(lagHours * 10) / 10,
          stale: lagHours !== null && lagHours > staleAfter,
        };
      });
      enriched.sort((a, b) => (b.lag_hours ?? -1) - (a.lag_hours ?? -1));

      const stale = enriched.filter((r) => r.stale).map((r) => r.resource);
      const empty = enriched.filter((r) => r.row_count === 0).map((r) => r.resource);
      return {
        resource: "",
        text: json({
          freshest_sync: freshest === null ? null : new Date(freshest).toISOString(),
          stale_after_hours: staleAfter,
          resources: enriched,
          stale,
          empty,
          notes: [
            "synced_at is when the scraper last SAW a row; updated_at is when it last CHANGED. A large gap between them is normal on quiet data.",
            "`freshness_from` names the column each lag was measured on. A resource measured on created_at has no sync stamp at all, so its lag tracks INSERTS, not syncs.",
            stale.length > 0
              ? `STALE: ${stale.join(", ")} — these lag the freshest resource by more than ${staleAfter}h. Treat their numbers as out of date and check the sync before reporting them.`
              : "No resource lags the freshest by more than the threshold.",
            empty.length > 0 ? `EMPTY (0 rows, never populated): ${empty.join(", ")}.` : null,
          ].filter(Boolean),
        }),
      };
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

// --- prompts -------------------------------------------------------------
//
// Canned analyses. The tools reward knowing that `occupied` and
// `occupancy_status` disagree by 60 units; a prompt encodes that knowledge so
// someone who has never seen the schema still gets the right number. Each one
// names the exact calls rather than describing them, because the failure mode
// these exist to prevent is a plausible-looking query against the wrong column.

interface McpPrompt {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  /** Resources the prompt reads; hidden from a token that cannot see them all. */
  requires: string[];
  build(args: Record<string, string>): string;
}

const PROMPTS: McpPrompt[] = [
  {
    name: "occupancy_reconciliation",
    description:
      "Reconcile the property's occupancy figures and explain any gap between the physical and leasing views.",
    arguments: [],
    requires: ["units", "leases"],
    build: () =>
      [
        "Reconcile occupancy for the property. Report BOTH views and explain the gap between them.",
        "",
        "1. aggregate_resource on `units` grouping by `occupied` (boolean) — the PHYSICAL view: is anyone living there?",
        "2. aggregate_resource on `units` grouping by `occupancy_status` — the LEASING view: Occupied / Vacant / Notice.",
        "3. The two disagree, and the difference is the Notice bucket: households under eviction or having given notice are still in the apartment, so they are occupied=true but not occupancy_status='Occupied'. State the size of that bucket explicitly.",
        "4. aggregate_resource on `leases` grouping by `status` for the full lifecycle. Note that `leases.status` carries Evicted and Former, which never appear on `units.lease_status` at all.",
        "5. Exclude `holding_unit` and `excluded_from_occupancy` units from any occupancy RATE, and say that you did.",
        "",
        "Give one headline number, say which view it is, and show the other alongside it.",
      ].join("\n"),
  },
  {
    name: "work_order_aging",
    description: "Age the open work-order backlog and surface what has been sitting longest.",
    arguments: [
      { name: "as_of", description: "ISO date to age against (default: today).", required: false },
    ],
    requires: ["work-orders"],
    build: (args) =>
      [
        `Age the open work-order backlog${args.as_of ? ` as of ${args.as_of}` : ""}.`,
        "",
        "1. describe_resource on `work-orders` first — read the actual `status` values rather than assuming 'Open'.",
        "2. aggregate_resource grouping by `status`, then by `priority`, to size the backlog.",
        "3. query_resource with a `reported_to` range to pull the oldest still-open orders, sorted by `date_reported` ascending.",
        "4. Group by `category` and by `technician` to show where the backlog sits.",
        "5. For the trend, aggregate_resource with period { column: \"reported\", interval: \"month\" } and group_by `status` — that separates a backlog that is GROWING from one that is merely old.",
        "",
        "`date_completed` is entered by hand: a blank means nobody typed it, not that the job is unfinished. Say which you are reporting.",
      ].join("\n"),
  },
  {
    name: "delinquency_by_building",
    description: "Break down resident balances and delinquency by building.",
    arguments: [],
    requires: ["units", "buildings"],
    build: () =>
      [
        "Break down delinquency by building.",
        "",
        "1. aggregate_resource on `units`, group_by `resman_building_id`, metric sum, measure `balance`.",
        "2. Repeat with `current_month_balance` to separate this month's charges from carried arrears.",
        "3. aggregate_resource group_by `resman_building_id` metric avg measure `times_late`.",
        "4. Resolve each building id to a name with get_resource on `buildings` — report names, not guids.",
        "5. Filter to `occupied=true` for a rate that means anything; a vacant unit's balance is a write-off, not delinquency.",
        "",
        "Nulls are excluded from averages. Report how many units carried no value if it is a large share.",
      ].join("\n"),
  },
  {
    name: "occupancy_trend",
    description: "Trend occupancy, delinquency or work-order load over time from the nightly snapshots.",
    arguments: [
      { name: "from", description: "Start date, ISO. Defaults to the whole series.", required: false },
      { name: "interval", description: "day | week | month | quarter | year (default month).", required: false },
    ],
    requires: ["property-snapshots"],
    build: (args) =>
      [
        `Trend the property over time${args.from ? ` from ${args.from}` : ""}.`,
        "",
        `1. aggregate_resource on \`property-snapshots\`, metric avg, measure \`occupancy_pct\`, period { column: "snapshot_date", interval: "${args.interval ?? "month"}" }${args.from ? `, ranges { snapshot_date_from: "${args.from}" }` : ""}.`,
        "2. This is the ONLY history in the system. units/leases/work-orders hold current state only, so a trend cannot come from them.",
        "3. BEFORE trending anything financial — balance_total, the aging buckets, delinquent_units, turns_in_progress, open_work_orders — add filters { source: \"nightly\" }. The 730 backfill rows are occupancy-only and null everywhere else, so an unfiltered average silently covers about nine days.",
        "4. Call describe_resource on `property-snapshots` first and read its caveats. They are the difference between a two-year trend and a nine-day one.",
        "5. occupancy_pct here is a THIRD definition, not equal to units.occupied or units.occupancy_status. Say which one you are quoting.",
      ].join("\n"),
  },
  {
    name: "utility_spend",
    description: "Summarise MLGW utility spend and consumption over a period.",
    arguments: [
      { name: "from", description: "Start date, ISO (e.g. 2026-01-01).", required: true },
      { name: "to", description: "End date, ISO.", required: true },
    ],
    requires: ["mlgw/bills", "mlgw/accounts"],
    build: (args) =>
      [
        `Summarise utility spend from ${args.from ?? "<from>"} to ${args.to ?? "<to>"}.`,
        "",
        `1. aggregate_resource on \`mlgw/bills\` with ranges { bill_date_from: "${args.from ?? ""}", bill_date_to: "${args.to ?? ""}" }, metric sum, measure \`amount_due\`.`,
        `2. Add period { column: "bill_date", interval: "month" } to the same call for the month-by-month trend. Gaps come back as explicit zeros — a zero month is a billing gap, not a cheap month, so check it before calling it a saving.`,
        "3. Repeat per utility: `electric_total`, `gas_total`, `water_total`, `sewer_total`.",
        "4. Repeat with the `_usage` measures. Spend and consumption move apart when rates change — report both or neither.",
        "5. aggregate_resource group_by `is_house_account` on `mlgw/accounts` to separate common-area accounts from unit accounts.",
        "6. For a per-unit view use aggregate_related from `units` over the `utility_accounts` relation — but note that relation is matched BY ADDRESS, so an unmatched account is invisible to it. Check the `(unmatched)` bucket it returns.",
      ].join("\n"),
  },
  {
    name: "gate_activity",
    description: "Summarise entry-log activity for a time window.",
    arguments: [
      { name: "from", description: "Window start, ISO timestamp.", required: true },
      { name: "to", description: "Window end, ISO timestamp.", required: false },
    ],
    requires: ["entry-logs", "guest-passes"],
    build: (args) =>
      [
        `Summarise gate activity from ${args.from ?? "<from>"}${args.to ? ` to ${args.to}` : ""}.`,
        "",
        `1. aggregate_resource on \`entry-logs\` with ranges { entered_from: "${args.from ?? ""}"${args.to ? `, entered_to: "${args.to}"` : ""} }, group_by \`entry_type\`.`,
        "2. Group by `scanner_id` to show which gate.",
        "3. For a by-night breakdown add period { column: \"entered\", interval: \"day\" }. That column is a TIMESTAMP, so it buckets in the property's local zone — a 10:30pm scan belongs to that evening, not to the next UTC day.",
        "4. query_resource on `entry-logs` over the same range, sorted by `entered_at`, for the individual scans.",
        "5. For guest entries, follow the `guest_pass` relation — a null guest_pass_id means a resident scan, not a missing pass.",
        "",
        "Report residents by unit rather than by name unless the question is about a specific person.",
      ].join("\n"),
  },
];

const PROMPT_BY_NAME = new Map(PROMPTS.map((p) => [p.name, p]));

/** A prompt is offered only when the token can read everything it would use. */
function promptVisible(staff: McpStaff, prompt: McpPrompt): boolean {
  return prompt.requires.every((r) => inScope(staff, r));
}

// --- resources -----------------------------------------------------------
//
// Attachable context rather than a tool round-trip: a client can pin the
// catalog into the conversation once instead of calling list_resources and
// describe_resource before every question.

const CATALOG_URI = "emberly://catalog";
const TRAPS_URI = "emberly://data-traps";

/**
 * The traps that have each produced a confidently wrong answer against this
 * data. Kept here, next to the tools, rather than only in docs/ — the caller
 * that needs them is the one that never reads the repository.
 */
const DATA_TRAPS = `# Traps in the Emberly mirror

## occupied vs occupancy_status — they differ by 60 units
- units.occupied (boolean): is anyone living there? Use for anything PHYSICAL — parking, utilities, access control.
- units.occupancy_status (Occupied/Vacant/Notice): use for LEASING and reporting.
The gap is the Notice bucket — under eviction or notice given, still in the apartment.
Grouping by occupancy_status to answer "how many units are occupied" undercounts by 60.

## units.lease_status is narrower than leases.status
units.lease_status comes from the All-Units report (8 values). leases.status is the full
lifecycle (12), including Evicted and Former, which NEVER appear on the units table.
The two disagree on 14 units because they come from different reports.

## synced_at is not updated_at
synced_at = the scraper last SAW the row. updated_at = the row last CHANGED.
They sit far apart when nothing is changing. That is normal, not an outage.

## Manual fields are sparse
Vehicle registration, holding_unit, date_completed and similar are typed by hand in ResMan.
A blank means nobody entered it, NOT that the answer is no. Report the data-entry rate, not
a false zero.

## mlgw/accounts.property_name holds a UUID
Despite the name it currently stores the property id. Group by resman_property_id instead.

## units -> mlgw/accounts is matched by ADDRESS
Not by a shared key. An unmatched account is invisible to the relation; aggregate_related
returns an "(unmatched)" bucket, and that number is part of the answer.

## The mirror has no history — property-snapshots does
units, leases and work-orders hold CURRENT state, upserted every sync. "How has vacancy moved
since spring" cannot be answered from them however it is phrased. The property-snapshots
resource is the only history: daily rows since 2024-07-21.
Its coverage is uneven — occupancy runs the full two years, but every financial and
work-order column is null before 2026-07-21 (source='nightly'). Filter to source=nightly
before trending money, or a two-year average quietly covers nine days.

## Free text is not a category
title, notes, completion_notes and names are deliberately not groupable. Search them.

## Aggregate truncation
sum/avg/min/max scan up to 20,000 rows and set truncated:true. A truncated average is not a
smaller average, it is a wrong one. Check the flag.`;

function catalogText(staff: McpStaff): string {
  return json({
    server: SERVER_INFO,
    resources: RESMAN_RESOURCES.filter((r) => inScope(staff, r.name)).map((r) => ({
      resource: r.name,
      id_column: r.idColumn,
      columns: r.publicColumns,
      filters: Object.keys(r.filters),
      ranges: Object.keys(r.ranges).map((p) => `${p}_from / ${p}_to`),
      searchable: r.searchable,
      groupable: r.groupable,
      measures: r.measures,
      sortable: r.sortable,
      periods: Object.entries(r.periods).map(([name, p]) => ({ column: name, kind: p.kind })),
      entities: r.entities,
      notes: r.notes,
      relations: r.relations.map((rel) => ({
        name: rel.name, target: rel.resource, kind: rel.kind, note: rel.note,
      })),
    })),
  });
}

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
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "prompts/list":
      return reply({
        prompts: PROMPTS.filter((p) => promptVisible(ctx.staff, p)).map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        })),
      });
    case "prompts/get": {
      const name = String(params.name ?? "");
      const prompt = PROMPT_BY_NAME.get(name);
      // Out-of-scope prompts are reported as unknown rather than forbidden: a
      // distinct "not authorized" would confirm which resources exist behind a
      // token that cannot read them.
      if (!prompt || !promptVisible(ctx.staff, prompt)) return fail(-32602, `Unknown prompt "${name}"`);
      const args = (params.arguments ?? {}) as Record<string, string>;
      return reply({
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text: prompt.build(args) } }],
      });
    }
    case "resources/list":
      return reply({
        resources: [
          {
            uri: CATALOG_URI,
            name: "Resource catalog",
            description:
              "Every resource this token can read, with its columns, filters, ranges, searchable/groupable/measure allowlists and declared relations.",
            mimeType: "application/json",
          },
          {
            uri: TRAPS_URI,
            name: "Data traps",
            description:
              "Known ways to get a confidently wrong answer from this data. Read before reporting a number.",
            mimeType: "text/markdown",
          },
        ],
      });
    case "resources/read": {
      const uri = String(params.uri ?? "");
      if (uri === CATALOG_URI) {
        return reply({ contents: [{ uri, mimeType: "application/json", text: catalogText(ctx.staff) }] });
      }
      if (uri === TRAPS_URI) {
        return reply({ contents: [{ uri, mimeType: "text/markdown", text: DATA_TRAPS }] });
      }
      return fail(-32602, `Unknown resource URI "${uri}"`);
    }
    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return fail(-32602, `Unknown tool "${name}"`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      // Budget is spent per TOOL CALL, not per HTTP request: a JSON-RPC batch
      // carries many calls in one request, so metering the request would let a
      // batch of 500 through as a single unit.
      const within = await checkRateLimit({
        bucket: `mcp-calls:${ctx.staff.tokenId}`,
        maxAttempts: CALL_BUDGET_MAX,
        windowMs: CALL_BUDGET_WINDOW_MS,
      });
      if (!within) {
        void logAccessTokenUse(ctx.client, ctx.staff, {
          tool: name, args, ok: false, error: "call budget exceeded",
        });
        return fail(-32003, `Call budget exceeded (${CALL_BUDGET_MAX} per 15 minutes). Retry shortly.`);
      }
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

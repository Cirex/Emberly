/**
 * Generic query engine + route factories for the private read-only ResMan REST API.
 *
 * A single pair of factories (`createListRoute` / `createDetailRoute`) turns a
 * `ResmanResource` into GET handlers, so all ~11 resources share one implementation
 * (pagination, filtering, column allowlisting, response envelope). Every route
 * is gated by `requireResmanApiKey` and reads through the service-role client.
 *
 * Response envelopes:
 *   list   -> { data: Row[], pagination: { limit, offset, count, hasMore } }
 *   detail -> { data: Row } | 404 { error: "Not found" }
 */

import { NextResponse } from "next/server";
import {
  type ResmanApiAuthResult,
  requireResmanApiKey,
  tokenForbiddenForResource,
} from "./resman-api-auth";
import type { ResmanResource } from "./resman-resources";
import { createUntypedAdminClient } from "./supabase/admin";
import type { UntypedSupabase } from "./supabase/types";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface ListPagination {
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
}

export interface ListResult {
  data: Record<string, unknown>[];
  pagination: ListPagination;
}

/** Client seam so route handlers can be driven with a fake client in tests. */
let clientOverride: UntypedSupabase | null = null;

export function setResmanClientForTests(client: UntypedSupabase | null): void {
  clientOverride = client;
}

function pmClient(): UntypedSupabase {
  if (clientOverride) return clientOverride;
  return createUntypedAdminClient();
}

/** Parses and clamps limit/offset. Invalid or absent values fall back to defaults. */
export function parseListParams(searchParams: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const rawOffset = Number.parseInt(searchParams.get("offset") ?? "", 10);

  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  return { limit, offset };
}

/** Resolves the active equality filters from the query string for a resource. */
export function resolveFilters(
  resource: ResmanResource,
  searchParams: URLSearchParams
): { column: string; value: string | boolean }[] {
  const entries: { column: string; value: string | boolean }[] = [];

  for (const [param, column] of Object.entries(resource.filters)) {
    const raw = searchParams.get(param);
    if (raw === null) continue;

    if (resource.booleanFilters.includes(param)) {
      if (raw === "true") entries.push({ column, value: true });
      else if (raw === "false") entries.push({ column, value: false });
      // ignore non-boolean values for boolean filters
      continue;
    }

    entries.push({ column, value: raw });
  }

  return entries;
}

/**
 * Resolves a substring search: `?q=<term>` against the resource's `searchable`
 * columns, OR'd together.
 *
 * Returns null when the resource declares nothing searchable or the term is
 * too short. The two-character floor is not cosmetic — `%a%` matches nearly
 * every row, so it is a full table scan that also returns everything, which is
 * the worst of both.
 *
 * PostgREST `or=` takes a comma-separated list, and both `,` and `)` terminate
 * a clause, so a term containing either would break out of the expression it
 * sits in. They are stripped rather than escaped: this is a convenience search,
 * and no legitimate term needs them.
 */
export function resolveSearch(
  resource: ResmanResource,
  searchParams: URLSearchParams,
): { expression: string; term: string; columns: readonly string[] } | null {
  if (resource.searchable.length === 0) return null;
  const raw = searchParams.get("q")?.trim() ?? "";
  const term = raw.replace(/[,()*\\]/g, "").trim();
  if (term.length < 2) return null;
  const expression = resource.searchable.map((c) => `${c}.ilike.*${term}*`).join(",");
  return { expression, term, columns: resource.searchable };
}

/** One inclusive range bound resolved from `<param>_from` / `<param>_to`. */
export interface RangeBound {
  column: string;
  op: "gte" | "lte";
  value: string;
}

/**
 * Resolves inclusive range bounds for the resource's declared `ranges`.
 *
 * Unlike `resolveSince`, a malformed bound is DROPPED rather than failing open
 * on the whole request: ranges narrow, and silently ignoring one the caller
 * asked for would answer a different question than the one posed. Callers see
 * which bounds applied in the response envelope.
 */
export function resolveRanges(
  resource: ResmanResource,
  searchParams: URLSearchParams,
): RangeBound[] {
  const bounds: RangeBound[] = [];
  for (const [param, column] of Object.entries(resource.ranges)) {
    for (const [suffix, op] of [["_from", "gte"], ["_to", "lte"]] as const) {
      const raw = searchParams.get(`${param}${suffix}`)?.trim();
      if (!raw) continue;
      // Accept a date, a date-time, or a plain number — anything else is a
      // caller error and is dropped rather than passed to Postgres to reject.
      const numeric = Number(raw);
      const looksDate = /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw);
      if (!looksDate && !Number.isFinite(numeric)) continue;
      bounds.push({ column, op, value: raw });
    }
  }
  return bounds;
}

/**
 * Resolves `?sort=<column>&dir=asc|desc`, restricted to the resource's
 * `sortable` allowlist. Returns null to leave the resource's default order.
 */
export function resolveSort(
  resource: ResmanResource,
  searchParams: URLSearchParams,
): { column: string; ascending: boolean } | null {
  const column = searchParams.get("sort")?.trim();
  if (!column || !resource.sortable.includes(column)) return null;
  return { column, ascending: searchParams.get("dir")?.trim().toLowerCase() !== "desc" };
}

/**
 * Resolves `?columns=a,b,c` to a projection of the resource's PUBLIC columns.
 *
 * Intersected with `publicColumns`, never unioned: naming a withheld column
 * gets you nothing, not the column. Returns null (= all public columns) when
 * absent or when nothing valid survives, so a typo degrades to the full row
 * rather than an empty one.
 */
export function resolveProjection(
  resource: ResmanResource,
  searchParams: URLSearchParams,
): readonly string[] | null {
  const raw = searchParams.get("columns")?.trim();
  if (!raw) return null;
  const asked = new Set(raw.split(",").map((c) => c.trim()).filter(Boolean));
  const kept = resource.publicColumns.filter((c) => asked.has(c));
  return kept.length > 0 ? kept : null;
}

/**
 * Full ISO-8601 date-time with a timezone — `2026-07-24T12:00:00Z` or
 * `...+02:00`, with optional fractional seconds.
 *
 * Deliberately strict, because `new Date()` is not: it reads "0" as the year
 * 2000 and "3000" as the year 3000. A bound in the FUTURE returns nothing,
 * which on this endpoint means a technician's board goes blank — so a value
 * that is anything other than an unambiguous instant must not become a filter.
 * The only producer is the server's own `updated_at` echoed back by the device,
 * which always matches this.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Resolves the delta bound from the query string, or null when absent/invalid.
 *
 * A malformed timestamp is IGNORED rather than 400'd: this parameter only
 * NARROWS a result set, so failing open returns the full list — correct, just
 * not cheap. Failing closed on a client bug would instead hide every row, and
 * the caller has no way to tell an empty delta from an empty table.
 */
export function resolveSince(
  resource: ResmanResource,
  searchParams: URLSearchParams,
): { column: string; value: string } | null {
  if (!resource.since) return null;
  const raw = searchParams.get(resource.since.param)?.trim();
  if (!raw || !ISO_INSTANT.test(raw)) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return { column: resource.since.column, value: parsed.toISOString() };
}

/** Projects a raw DB row onto the resource's public column set (applying any derive step). */
export function shapeRow(resource: ResmanResource, row: Record<string, unknown>): Record<string, unknown> {
  const derived = resource.derive ? resource.derive(row) : row;
  const out: Record<string, unknown> = {};
  for (const column of resource.publicColumns) {
    if (column in derived) out[column] = derived[column];
  }
  return out;
}

/** Executes a list query for a resource. Client is injectable for tests. */
export async function listResource(
  resource: ResmanResource,
  searchParams: URLSearchParams,
  client: UntypedSupabase = pmClient(),
  scanner = false
): Promise<ListResult> {
  const { limit, offset } = parseListParams(searchParams);

  let query = client
    .from(resource.table)
    .select(resource.selectColumns.join(","), { count: "exact" });

  // Applied before user filters, so no query-string combination can widen a
  // scanner's view past it. Counts reflect the trimmed set.
  if (scanner && resource.scannerVisible) query = query.or(resource.scannerVisible);

  for (const { column, value } of resolveFilters(resource, searchParams)) {
    query = query.eq(column, value);
  }

  // Ranges and search narrow further. Search is applied as a single OR group so
  // it ANDs with every other predicate rather than widening past them — an
  // `or()` chained beside `eq()` filters in PostgREST would otherwise let a
  // search term pull in rows the filters excluded.
  for (const bound of resolveRanges(resource, searchParams)) {
    query = bound.op === "gte" ? query.gte(bound.column, bound.value) : query.lte(bound.column, bound.value);
  }
  const search = resolveSearch(resource, searchParams);
  if (search) query = query.or(search.expression);

  // Delta bound last, so it narrows whatever the filters selected. `gt` not
  // `gte`: the caller passes the timestamp it already has, and re-sending that
  // row every poll is the cost this parameter exists to avoid.
  const since = resolveSince(resource, searchParams);
  if (since) query = query.gt(since.column, since.value);

  const sort = resolveSort(resource, searchParams);
  if (sort) query = query.order(sort.column, { ascending: sort.ascending });
  else query = query.order(resource.order.column, { ascending: resource.order.ascending });
  if (!sort && resource.tiebreak) {
    query = query.order(resource.tiebreak.column, { ascending: resource.tiebreak.ascending });
  }
  // ALWAYS last: the primary key, which is unique, so the sort is a TOTAL order.
  //
  // Without it, offset paging over a tied sort column is non-deterministic —
  // Postgres may return tied rows in a different order for each page request, so
  // a row can appear on two pages while another appears on none. Measured on the
  // live mirror: work-orders sorts by date_reported, which has only 284 distinct
  // values across 4,072 rows (99 rows share one date), and paging the whole
  // table yielded 4,001 DISTINCT ids — 71 work orders silently missing from
  // every full load, every time.
  //
  // It also made the maintenance app's row-count drift check fire on every tick,
  // turning a cheap delta poll into a full 3.78 MB re-download every 15 seconds.
  query = query.order(resource.idColumn, { ascending: true });
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const projection = resolveProjection(resource, searchParams);
  const rows: Record<string, unknown>[] = (data ?? []).map((row: Record<string, unknown>) => {
    const shaped = shapeRow(resource, row);
    if (!projection) return shaped;
    const out: Record<string, unknown> = {};
    for (const column of projection) if (column in shaped) out[column] = shaped[column];
    return out;
  });
  const total = typeof count === "number" ? count : offset + rows.length;

  return {
    data: rows,
    pagination: { limit, offset, count: total, hasMore: offset + rows.length < total },
  };
}

export interface ResourceProfile {
  resource: string;
  row_count: number;
  /** Newest `synced_at` on the table, or null when it has no such column. */
  last_synced_at: string | null;
  /** Observed distinct values per groupable column, most common first. */
  distinct_values: Record<string, { value: string | null; count: number }[]>;
}

/** Cap on distinct values reported per column before the list is trimmed. */
const DISTINCT_CAP = 25;
/** Rows sampled to learn a groupable column's domain. */
const DISTINCT_SAMPLE = 5_000;

/**
 * Profiles a resource for discovery: how many rows, how fresh, and what values
 * its groupable columns actually hold.
 *
 * This exists to stop callers guessing. Without it an agent writes
 * `occupancy_status = 'Vacant '` or invents a status the property never uses,
 * gets zero rows, and reports "none" — which reads identically to a real zero.
 *
 * Distincts are learned from a bounded sample rather than a full scan, so on a
 * large table they are indicative, not exhaustive; the sample size is reported
 * so a caller can tell the difference.
 */
export async function describeResourceData(
  resource: ResmanResource,
  client: UntypedSupabase = pmClient(),
): Promise<ResourceProfile & { sampled: number }> {
  const { count, error: countError } = await client
    .from(resource.table)
    .select(resource.idColumn, { count: "exact", head: true });
  if (countError) throw countError;

  let lastSynced: string | null = null;
  if (resource.selectColumns.includes("synced_at")) {
    const { data } = await client
      .from(resource.table)
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1);
    lastSynced = (data?.[0] as { synced_at?: string } | undefined)?.synced_at ?? null;
  }

  const distinct: ResourceProfile["distinct_values"] = {};
  let sampled = 0;
  if (resource.groupable.length > 0) {
    const { data, error } = await client
      .from(resource.table)
      .select(resource.groupable.join(","))
      .limit(DISTINCT_SAMPLE);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    sampled = rows.length;
    for (const column of resource.groupable) {
      const tally = new Map<string | null, number>();
      for (const row of rows) {
        const raw = row[column];
        const key = raw === null || raw === undefined ? null : String(raw);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      distinct[column] = [...tally.entries()]
        .map(([value, n]) => ({ value, count: n }))
        .sort((a, b) => b.count - a.count)
        .slice(0, DISTINCT_CAP);
    }
  }

  return {
    resource: resource.name,
    row_count: count ?? 0,
    last_synced_at: lastSynced,
    distinct_values: distinct,
    sampled,
  };
}

/** A single aggregate bucket. `value` is null for a metric with nothing to measure. */
export interface AggregateBucket {
  group: string | null;
  count: number;
  value?: number | null;
}

export interface AggregateResult {
  resource: string;
  group_by: string | null;
  metric: "count" | "sum" | "avg" | "min" | "max";
  measure: string | null;
  buckets: AggregateBucket[];
  /** Rows the aggregate was computed over (count metrics read no rows at all). */
  scanned: number;
  /** True when the measure scan hit its cap — the numbers are then INCOMPLETE. */
  truncated: boolean;
}

/** Hard ceiling on rows a measure aggregate will pull to compute in-process. */
const AGGREGATE_SCAN_CAP = 20_000;

/**
 * Group-and-measure over a resource, honouring every filter `listResource`
 * honours.
 *
 * Two strategies, because they have very different costs:
 *
 *  - `count` runs one `head: true, count: "exact"` query per group value and
 *    transfers NO rows. Exact at any table size, and the reason "how many X by
 *    Y" stopped being a paging exercise.
 *  - `sum`/`avg`/`min`/`max` need the values, so they pull just the group and
 *    measure columns, capped at AGGREGATE_SCAN_CAP. Hitting the cap sets
 *    `truncated` and the caller is told the figures are partial — a silently
 *    truncated average is worse than no average.
 *
 * Group values come from the caller-supplied `groupValues` (normally taken from
 * describe_resource's distincts), so this never has to guess the domain.
 */
export async function aggregateResource(
  resource: ResmanResource,
  searchParams: URLSearchParams,
  opts: {
    groupBy: string | null;
    groupValues: readonly (string | null)[];
    metric: "count" | "sum" | "avg" | "min" | "max";
    measure: string | null;
  },
  client: UntypedSupabase = pmClient(),
): Promise<AggregateResult> {
  const applyPredicates = (q: ReturnType<ReturnType<UntypedSupabase["from"]>["select"]>) => {
    let query = q;
    for (const { column, value } of resolveFilters(resource, searchParams)) query = query.eq(column, value);
    for (const b of resolveRanges(resource, searchParams)) {
      query = b.op === "gte" ? query.gte(b.column, b.value) : query.lte(b.column, b.value);
    }
    const search = resolveSearch(resource, searchParams);
    if (search) query = query.or(search.expression);
    return query;
  };

  const base = { resource: resource.name, group_by: opts.groupBy, metric: opts.metric, measure: opts.measure };

  if (opts.metric === "count") {
    const buckets: AggregateBucket[] = [];
    const groups: (string | null)[] = opts.groupBy ? [...opts.groupValues] : [null];
    for (const group of groups) {
      let q = applyPredicates(
        client.from(resource.table).select(resource.idColumn, { count: "exact", head: true }),
      );
      if (opts.groupBy) {
        q = group === null ? q.is(opts.groupBy, null) : q.eq(opts.groupBy, group);
      }
      const { count, error } = await q;
      if (error) throw error;
      buckets.push({ group, count: count ?? 0 });
    }
    buckets.sort((a, b) => b.count - a.count);
    return { ...base, buckets, scanned: 0, truncated: false };
  }

  if (!opts.measure) throw new Error(`Metric "${opts.metric}" requires a measure column.`);
  const columns = opts.groupBy ? [opts.groupBy, opts.measure] : [opts.measure];
  const { data, error } = await applyPredicates(
    client.from(resource.table).select(columns.join(",")),
  ).limit(AGGREGATE_SCAN_CAP);
  if (error) throw error;

  const rows = (data ?? []) as Record<string, unknown>[];
  const acc = new Map<string | null, { n: number; sum: number; min: number; max: number }>();
  for (const row of rows) {
    const group = opts.groupBy ? ((row[opts.groupBy] ?? null) as string | null) : null;
    // Null/empty must be rejected BEFORE Number(): `Number(null)` and
    // `Number("")` are both 0, not NaN, so a Number.isFinite guard alone lets
    // every missing value in as a real zero — which silently halves an average
    // over a nullable column. SQL excludes nulls from aggregates; so do we.
    const raw = row[opts.measure];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const cur = acc.get(group) ?? { n: 0, sum: 0, min: Infinity, max: -Infinity };
    cur.n += 1;
    cur.sum += value;
    cur.min = Math.min(cur.min, value);
    cur.max = Math.max(cur.max, value);
    acc.set(group, cur);
  }

  const buckets: AggregateBucket[] = [...acc.entries()].map(([group, a]) => ({
    group,
    count: a.n,
    value:
      opts.metric === "sum" ? a.sum
      : opts.metric === "avg" ? a.sum / a.n
      : opts.metric === "min" ? a.min
      : a.max,
  }));
  buckets.sort((x, y) => (y.value ?? 0) - (x.value ?? 0));

  return { ...base, buckets, scanned: rows.length, truncated: rows.length >= AGGREGATE_SCAN_CAP };
}

export interface RelatedAggregateResult extends AggregateResult {
  /** The resource the group column belongs to (the parent side of the hop). */
  grouped_by_resource: string;
  relation: string;
  /** Parent rows read to build the key -> group map. */
  parents_scanned: number;
  /** True when either side hit its scan cap — the numbers are then INCOMPLETE. */
  parents_truncated: boolean;
}

/** Parent rows read to build the join map before the target is touched. */
const RELATED_PARENT_CAP = 20_000;
/**
 * Keys per `in(...)` batch. PostgREST takes filters in the query string, so a
 * batch of uuids becomes URL length — 100 keys is ~3.8 KB, comfortably inside
 * every proxy's request-line limit. Larger batches are fewer round trips and a
 * 431 waiting to happen.
 */
const RELATED_KEY_CHUNK = 100;

/**
 * Aggregate one resource GROUPED BY an attribute of a resource it is related to:
 * "total transaction charges by building", "work orders by unit classification",
 * "utility spend by whether the unit is occupied".
 *
 * PostgREST cannot express this as a single grouped join over the mirror, so it
 * runs as a two-sided scan:
 *
 *   1. Read the parent's join key and group column (predicates apply to the
 *      PARENT — "occupied units", "buildings on this property").
 *   2. Read the target's join key and measure in `in(...)` batches over those
 *      keys, and fold each row into its parent's bucket.
 *
 * Both sides are capped and both caps are REPORTED. Unlike `aggregateResource`,
 * even a `count` here has to read rows: the grouping attribute lives on the
 * other table, so there is no per-group predicate a HEAD count could use. That
 * makes this the expensive tool of the set — reach for `aggregate_resource`
 * whenever the group column is on the same resource as the measure.
 *
 * Rows whose foreign key matched no scanned parent are counted separately as
 * `unmatched` rather than silently dropped: on an address-matched relation like
 * units -> mlgw/accounts, that number IS the answer to "how much are we failing
 * to attribute".
 */
export async function aggregateRelated(
  parent: ResmanResource,
  target: ResmanResource,
  relation: { localColumn: string; foreignColumn: string; name: string },
  searchParams: URLSearchParams,
  opts: {
    groupBy: string | null;
    metric: "count" | "sum" | "avg" | "min" | "max";
    measure: string | null;
  },
  client: UntypedSupabase = pmClient(),
): Promise<RelatedAggregateResult> {
  // --- 1. parent side: join key -> group value ---
  const parentColumns = opts.groupBy
    ? [relation.localColumn, opts.groupBy]
    : [relation.localColumn];
  let parentQuery = client.from(parent.table).select([...new Set(parentColumns)].join(","));
  for (const { column, value } of resolveFilters(parent, searchParams)) {
    parentQuery = parentQuery.eq(column, value);
  }
  for (const b of resolveRanges(parent, searchParams)) {
    parentQuery = b.op === "gte" ? parentQuery.gte(b.column, b.value) : parentQuery.lte(b.column, b.value);
  }
  const parentSearch = resolveSearch(parent, searchParams);
  if (parentSearch) parentQuery = parentQuery.or(parentSearch.expression);

  const { data: parentData, error: parentError } = await parentQuery.limit(RELATED_PARENT_CAP);
  if (parentError) throw parentError;
  const parentRows = (parentData ?? []) as Record<string, unknown>[];

  const groupByKey = new Map<string, string | null>();
  for (const row of parentRows) {
    const key = row[relation.localColumn];
    if (key === null || key === undefined || key === "") continue;
    groupByKey.set(String(key), opts.groupBy ? ((row[opts.groupBy] ?? null) as string | null) : null);
  }

  const acc = new Map<string | null, { n: number; sum: number; min: number; max: number }>();
  const bump = (group: string | null, value: number | null) => {
    const cur = acc.get(group) ?? { n: 0, sum: 0, min: Infinity, max: -Infinity };
    cur.n += 1;
    if (value !== null) {
      cur.sum += value;
      cur.min = Math.min(cur.min, value);
      cur.max = Math.max(cur.max, value);
    }
    acc.set(group, cur);
  };

  // --- 2. target side: fold each row into its parent's bucket ---
  const keys = [...groupByKey.keys()];
  const targetColumns = opts.measure
    ? [...new Set([relation.foreignColumn, opts.measure])]
    : [relation.foreignColumn];
  let scanned = 0;
  let unmatched = 0;
  let targetTruncated = false;

  for (let i = 0; i < keys.length && scanned < AGGREGATE_SCAN_CAP; i += RELATED_KEY_CHUNK) {
    const chunk = keys.slice(i, i + RELATED_KEY_CHUNK);
    const { data, error } = await client
      .from(target.table)
      .select(targetColumns.join(","))
      .in(relation.foreignColumn, chunk)
      .limit(AGGREGATE_SCAN_CAP - scanned);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    scanned += rows.length;

    for (const row of rows) {
      const fk = row[relation.foreignColumn];
      const key = fk === null || fk === undefined ? "" : String(fk);
      if (!groupByKey.has(key)) {
        unmatched += 1;
        continue;
      }
      const group = groupByKey.get(key) ?? null;
      if (opts.metric === "count" || !opts.measure) {
        bump(group, null);
        continue;
      }
      // Same null discipline as aggregateResource: Number(null) is 0, so a
      // missing measure must be rejected before coercion, not after.
      const raw = row[opts.measure];
      if (raw === null || raw === undefined || raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      bump(group, value);
    }
    if (scanned >= AGGREGATE_SCAN_CAP) targetTruncated = true;
  }

  const buckets: AggregateBucket[] = [...acc.entries()].map(([group, a]) => ({
    group,
    count: a.n,
    ...(opts.metric === "count"
      ? {}
      : {
          value:
            a.n === 0 || a.min === Infinity ? null
            : opts.metric === "sum" ? a.sum
            : opts.metric === "avg" ? a.sum / a.n
            : opts.metric === "min" ? a.min
            : a.max,
        }),
  }));
  buckets.sort((x, y) =>
    opts.metric === "count" ? y.count - x.count : (y.value ?? 0) - (x.value ?? 0),
  );

  return {
    resource: target.name,
    grouped_by_resource: parent.name,
    relation: relation.name,
    group_by: opts.groupBy,
    metric: opts.metric,
    measure: opts.measure,
    buckets: unmatched > 0 ? [...buckets, { group: "(unmatched)", count: unmatched }] : buckets,
    scanned,
    truncated: targetTruncated,
    parents_scanned: parentRows.length,
    parents_truncated: parentRows.length >= RELATED_PARENT_CAP,
  };
}

/** Executes a detail (by-id) query for a resource. Returns null when not found. */
export async function getResource(
  resource: ResmanResource,
  id: string,
  client: UntypedSupabase = pmClient(),
  scanner = false
): Promise<Record<string, unknown> | null> {
  let query = client
    .from(resource.table)
    .select(resource.selectColumns.join(","))
    .eq(resource.idColumn, id);

  // A row a scanner can't list is also a row it can't fetch by id.
  if (scanner && resource.scannerVisible) query = query.or(resource.scannerVisible);

  const { data, error } = await query.maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return shapeRow(resource, data as Record<string, unknown>);
}

type DetailContext = { params: Promise<{ id: string }> };

/**
 * Per-caller resource authorization. Two independent gates:
 *
 *   - Scanner access is OPT-IN per resource: a gate device may only read a
 *     resource that declares `scannerVisible` (today just `units`). Everything
 *     else — residents, leases, transactions, work orders, MLGW — is denied to a
 *     scanner credential so a compromised gate iPad can't read the roster or the
 *     financial ledger.
 *   - `eapi_` tokens are gated on their role + scopes: a scoped field-device
 *     token (the maintenance/security apps) reads only its allowlisted surface;
 *     back-office tokens are limited only by their explicit scopes.
 */
function resourceForbidden(resource: ResmanResource, auth: Extract<ResmanApiAuthResult, { ok: true }>): boolean {
  if (auth.kind === "scanner") return !resource.scannerVisible;
  return tokenForbiddenForResource(auth.subject, resource.name);
}

export function createListRoute(resource: ResmanResource) {
  return async function GET(request: Request): Promise<NextResponse> {
    const auth = await requireResmanApiKey(request);
    if (!auth.ok) return auth.response;
    if (resourceForbidden(resource, auth)) {
      return NextResponse.json({ error: "Not authorized for this resource" }, { status: 403 });
    }

    try {
      const { searchParams } = new URL(request.url);
      const result = await listResource(resource, searchParams, pmClient(), auth.kind === "scanner");
      return NextResponse.json(result);
    } catch (error) {
      console.error(`[resman-api ${resource.name} list] Unexpected error:`, error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/** Builds a GET detail handler for a resource. */
export function createDetailRoute(resource: ResmanResource) {
  return async function GET(request: Request, context: DetailContext): Promise<NextResponse> {
    const auth = await requireResmanApiKey(request);
    if (!auth.ok) return auth.response;
    if (resourceForbidden(resource, auth)) {
      return NextResponse.json({ error: "Not authorized for this resource" }, { status: 403 });
    }

    try {
      const { id } = await context.params;
      const row = await getResource(resource, id, pmClient(), auth.kind === "scanner");
      if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ data: row });
    } catch (error) {
      console.error(`[resman-api ${resource.name} detail] Unexpected error:`, error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

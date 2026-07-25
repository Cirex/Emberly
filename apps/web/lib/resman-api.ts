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

  // Delta bound last, so it narrows whatever the filters selected. `gt` not
  // `gte`: the caller passes the timestamp it already has, and re-sending that
  // row every poll is the cost this parameter exists to avoid.
  const since = resolveSince(resource, searchParams);
  if (since) query = query.gt(since.column, since.value);

  query = query.order(resource.order.column, { ascending: resource.order.ascending });
  if (resource.tiebreak) {
    query = query.order(resource.tiebreak.column, { ascending: resource.tiebreak.ascending });
  }
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows: Record<string, unknown>[] = (data ?? []).map((row: Record<string, unknown>) =>
    shapeRow(resource, row)
  );
  const total = typeof count === "number" ? count : offset + rows.length;

  return {
    data: rows,
    pagination: { limit, offset, count: total, hasMore: offset + rows.length < total },
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

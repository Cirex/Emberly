/**
 * Supabase service-role client + mirror-table upsert helpers for the sync worker.
 *
 * The worker authenticates with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS;
 * the resman_* / mlgw_* tables have RLS enabled with no policies, so only the
 * service role can read/write them. Table typings are intentionally loose here
 * (the worker validates its own DTOs); emberly-web owns the authoritative
 * Database types.
 */
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { type EnvRecord, loadSupabaseCredentials } from "../config/env";

export type ServiceClient = SupabaseClient;

export function createServiceClient(env: EnvRecord): ServiceClient {
  const { url, serviceRoleKey } = loadSupabaseCredentials(env);
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const UPSERT_BATCH = 500;
const DELETE_BATCH = 200;
/** Max chunk statements issued to PostgREST at once (chunks have disjoint keys). */
const WRITE_CONCURRENCY = 4;
/** PostgREST caps an unbounded select at 1000 rows; page the key read at this size. */
const KEY_PAGE = 1000;

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

/** Split `items` into fixed-size chunks. */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface UpsertOutcome {
  upserted: number;
  deletedStale: number;
  /** True when `rows` was empty and the whole operation was skipped. */
  skippedEmpty: boolean;
}

/**
 * Idempotent upsert of freshly-scraped rows into a mirror table, with the two
 * guards the design (§3.3) requires:
 *
 *  - **never-delete-on-empty:** an empty `rows` array is a no-op, so a failed or
 *    partial scrape can never wipe the table.
 *  - **guarded delete-missing:** when `deleteMissing` is set, rows whose key is
 *    absent from the freshly-scraped set are deleted — but only when the scrape
 *    returned at least one row (guaranteed by the guard above).
 */
export async function upsertMirror(
  client: ServiceClient,
  table: string,
  rows: Array<Record<string, unknown>>,
  opts: {
    conflictColumn: string;
    keyColumn?: string;
    deleteMissing?: boolean;
    /**
     * Scope the delete-missing pass, so a partial (e.g. per-property) scrape only
     * deletes stale rows within that scope — never rows outside it. When omitted,
     * delete-missing spans the whole table.
     */
    deleteScope?: { column: string; value: unknown };
  },
): Promise<UpsertOutcome> {
  if (rows.length === 0) {
    return { upserted: 0, deletedStale: 0, skippedEmpty: true };
  }

  // Collapse duplicate conflict keys (last write wins). A single
  // `INSERT ... ON CONFLICT DO UPDATE` statement cannot affect the same row
  // twice, and mirrors the Swift importers' by-key dictionary upsert.
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) byKey.set(String(row[opts.conflictColumn]), row);
  const deduped = [...byKey.values()];

  // Chunks have disjoint conflict keys (deduped above), so they never contend on
  // the same row and can be written with bounded parallelism.
  const upsertChunks = chunked(deduped, UPSERT_BATCH);
  let quarantined = 0;
  await inParallel(upsertChunks, WRITE_CONCURRENCY, async (chunk) => {
    const { error } = await client.from(table).upsert(chunk, { onConflict: opts.conflictColumn });
    if (!error) return;

    // The chunk failed. Historically this threw, so ONE malformed scraped row
    // (a CHECK/NOT-NULL/type violation) aborted the whole ~500-row batch — and,
    // in multi-table jobs, left earlier tables written and later ones not.
    // Isolate the offender by retrying the chunk row-by-row: good rows persist,
    // bad rows are quarantined (skipped + logged). If NOTHING in the chunk can
    // be written, that is systemic (dropped connection, a column wrong for every
    // row) rather than one bad row, so re-throw to keep failing loud.
    const failures: string[] = [];
    let wrote = 0;
    for (const row of chunk) {
      const { error: rowError } = await client
        .from(table)
        .upsert([row], { onConflict: opts.conflictColumn });
      if (rowError) failures.push(`${String(row[opts.conflictColumn])}: ${rowError.message}`);
      else wrote += 1;
    }
    if (wrote === 0) {
      throw new Error(
        `upsert into ${table} failed for all ${chunk.length} rows in a chunk: ${error.message}`,
      );
    }
    quarantined += failures.length;
    console.error(
      `[upsertMirror] ${table}: quarantined ${failures.length} bad row(s) of ${chunk.length}: ` +
        failures.slice(0, 5).join(" | ") +
        (failures.length > 5 ? " …" : ""),
    );
  });
  const upserted = deduped.length - quarantined;

  let deletedStale = 0;
  if (opts.deleteMissing) {
    const keyColumn = opts.keyColumn ?? opts.conflictColumn;
    const present = new Set(deduped.map((r) => String(r[keyColumn])));

    // Page the key read — an unbounded PostgREST select is capped at 1000 rows,
    // which would silently truncate the stale-set on large tables.
    const existingKeys: string[] = [];
    for (let from = 0; ; from += KEY_PAGE) {
      // A stable ORDER BY is required: without it, PostgREST range paging can
      // shift rows between pages (rows are also being inserted just above), so
      // some existing keys could be skipped and their stale rows survive the
      // delete-missing pass.
      let selectQuery = client
        .from(table)
        .select(keyColumn)
        .order(keyColumn, { ascending: true })
        .range(from, from + KEY_PAGE - 1);
      if (opts.deleteScope) selectQuery = selectQuery.eq(opts.deleteScope.column, opts.deleteScope.value);
      const { data, error } = await selectQuery;
      if (error) throw new Error(`read keys from ${table} failed: ${error.message}`);
      // The untyped-client select result is a union that doesn't overlap
      // Record<string, unknown> under strict TS; cast through unknown (runtime rows
      // are plain objects keyed by keyColumn).
      const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const r of batch) existingKeys.push(String(r[keyColumn]));
      if (batch.length < KEY_PAGE) break;
    }

    const stale = existingKeys.filter((key) => !present.has(key));
    const deleteChunks = chunked(stale, DELETE_BATCH);
    await inParallel(deleteChunks, WRITE_CONCURRENCY, async (chunk) => {
      let deleteQuery = client.from(table).delete().in(keyColumn, chunk);
      if (opts.deleteScope) deleteQuery = deleteQuery.eq(opts.deleteScope.column, opts.deleteScope.value);
      const { error: deleteError } = await deleteQuery;
      if (deleteError) throw new Error(`delete stale from ${table} failed: ${deleteError.message}`);
    });
    deletedStale = stale.length;
  }

  return { upserted, deletedStale, skippedEmpty: false };
}

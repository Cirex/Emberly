/**
 * Server-side translation pre-cache job (design: pre-translate on cron so the
 * techs' phones don't).
 *
 * After the work-orders sync, this reads every work order's prose, hashes each
 * distinct string (packages/core textHash — the SAME hash the device uses), and
 * translates only the ones whose hash isn't already cached — i.e. new or CHANGED
 * text. Results land in work_order_translations, keyed by (source_hash,
 * target_lang), which the maintenance app merges straight into its on-device
 * cache. Stale rows (a source whose text changed, so its old hash is no longer
 * live) are reaped.
 *
 * Content-addressed throughout: an unchanged work order costs nothing on a
 * re-run; a changed one re-translates exactly because its hash moved.
 */
import { textHash } from "@emberly/core";
import type { ServiceClient } from "../../db/client";
import type { Translator } from "../../shared/langbly";
import {
  groupByDirection,
  planServerTranslations,
} from "../derive/translation-routing";

export interface TranslateWorkOrdersDeps {
  supabase: ServiceClient;
  /** Null → the job no-ops (no LANGBLY_API_KEY configured). */
  translator: Translator | null;
  log?: (message: string) => void;
}

export interface TranslateWorkOrdersResult {
  distinctSources: number;
  alreadyCached: number;
  detected: number;
  translated: number;
  reaped: number;
  skippedNoTranslator: boolean;
}

const PAGE = 1000;
const DELETE_CHUNK = 200;

/** Distinct, trimmed prose across all work orders → its content hash. */
async function loadDistinctProse(
  supabase: ServiceClient,
): Promise<Map<string, string>> {
  const bySource = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("resman_work_orders")
      .select("title, notes, completion_notes")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load work-order prose: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      for (const field of [row.title, row.notes, row.completion_notes]) {
        const text = (field ?? "").trim();
        if (text && !bySource.has(text)) bySource.set(text, textHash(text));
      }
    }
    if (data.length < PAGE) break;
  }
  return bySource;
}

/** Every source_hash already in the cache (any target). */
async function loadCachedHashes(supabase: ServiceClient): Promise<Set<string>> {
  const cached = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("work_order_translations")
      .select("source_hash")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load cached hashes: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) cached.add(row.source_hash);
    if (data.length < PAGE) break;
  }
  return cached;
}

export async function translateWorkOrders(
  deps: TranslateWorkOrdersDeps,
): Promise<TranslateWorkOrdersResult> {
  const log = deps.log ?? (() => {});
  const zero: TranslateWorkOrdersResult = {
    distinctSources: 0,
    alreadyCached: 0,
    detected: 0,
    translated: 0,
    reaped: 0,
    skippedNoTranslator: false,
  };

  if (!deps.translator) {
    log("[translate-work-orders] no LANGBLY_API_KEY — skipping");
    return { ...zero, skippedNoTranslator: true };
  }

  const distinct = await loadDistinctProse(deps.supabase);
  if (distinct.size === 0) {
    log("[translate-work-orders] no prose to translate");
    return zero;
  }
  const liveHashes = new Set(distinct.values());
  const cachedHashes = await loadCachedHashes(deps.supabase);

  // New or changed sources = those whose hash isn't cached yet.
  const missing: string[] = [];
  for (const [source, hash] of distinct) {
    if (!cachedHashes.has(hash)) missing.push(source);
  }
  log(
    `[translate-work-orders] ${distinct.size} distinct, ${missing.length} new/changed, ${
      distinct.size - missing.length
    } cached`,
  );

  let translated = 0;
  if (missing.length > 0) {
    const detected = await deps.translator.detect(missing);
    const plans = planServerTranslations(missing, detected);
    const rows: Record<string, unknown>[] = [];
    for (const group of groupByDirection(plans)) {
      const outputs = await deps.translator.translateBatch(group.sources, group.from, group.to);
      group.sources.forEach((source, i) => {
        rows.push({
          source_hash: textHash(source),
          target_lang: group.to,
          source_lang: group.from,
          translated_text: outputs[i],
          char_count: source.length,
        });
      });
    }
    for (let i = 0; i < rows.length; i += DELETE_CHUNK) {
      const chunk = rows.slice(i, i + DELETE_CHUNK);
      const { error } = await deps.supabase
        .from("work_order_translations")
        .upsert(chunk, { onConflict: "source_hash,target_lang" });
      if (error) throw new Error(`upsert translations: ${error.message}`);
    }
    translated = rows.length;
  }

  const reaped = await reapStale(deps.supabase, liveHashes);
  log(`[translate-work-orders] translated ${translated}, reaped ${reaped}`);
  return {
    distinctSources: distinct.size,
    alreadyCached: distinct.size - missing.length,
    detected: missing.length,
    translated,
    reaped,
    skippedNoTranslator: false,
  };
}

/** Delete cache rows whose source is no longer among the live work orders. */
async function reapStale(supabase: ServiceClient, liveHashes: Set<string>): Promise<number> {
  const stale: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("work_order_translations")
      .select("source_hash")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`scan for stale: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (!liveHashes.has(row.source_hash)) stale.push(row.source_hash);
    }
    if (data.length < PAGE) break;
  }
  if (stale.length === 0) return 0;

  let deleted = 0;
  for (let i = 0; i < stale.length; i += DELETE_CHUNK) {
    const chunk = stale.slice(i, i + DELETE_CHUNK);
    const { error } = await supabase
      .from("work_order_translations")
      .delete()
      .in("source_hash", chunk);
    if (error) throw new Error(`reap stale: ${error.message}`);
    deleted += chunk.length;
  }
  return deleted;
}

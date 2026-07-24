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
import { inParallel, type ServiceClient } from "../../db/client";
import type { Translator } from "../../shared/langbly";
import { otherLang } from "../derive/translation-routing";
import { overrideFor } from "../derive/translation-overrides";

export interface TranslateWorkOrdersDeps {
  supabase: ServiceClient;
  /** Null → the job no-ops (no LANGBLY_API_KEY configured). */
  translator: Translator | null;
  /**
   * Language ResMan prose is authored in. Defaults to English, which is what
   * this property's work orders actually are.
   *
   * We do NOT detect per string here: Langbly's /detect returns "und" with zero
   * confidence for everything, and the detectedSourceLanguage on a translate
   * call is wrong too (it reported "en" for "Fuga de agua caliente"). Guessing
   * from an unreliable signal would route text the wrong way; assuming the
   * corpus language is both correct and cheaper. The reverse direction — a
   * tech's Spanish note read in English — is handled on-device, where Apple's
   * NLLanguageRecognizer does work.
   */
  sourceLang?: "en" | "es";
  /** Batches translated in parallel. Defaults to TRANSLATE_CONCURRENCY. */
  concurrency?: number;
  log?: (message: string) => void;
}

export interface TranslateWorkOrdersResult {
  distinctSources: number;
  alreadyCached: number;
  detected: number;
  translated: number;
  reaped: number;
  /** Rows written from the curated jargon list rather than the translator. */
  overrides: number;
  skippedNoTranslator: boolean;
}

const PAGE = 1000;
const DELETE_CHUNK = 200;
/** Sources per translate request — the client batches internally too, but this
 *  bounds a single failure's blast radius and gives progress logging. */
const TRANSLATE_BATCH = 100;
/** Batches in flight at once. Bounded well under what the API tolerated. */
const TRANSLATE_CONCURRENCY = 5;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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
    overrides: 0,
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

  const from = deps.sourceLang ?? "en";
  const to = otherLang(from);

  // Curated jargon wins over the machine translation, and is re-applied every
  // run regardless of the cache — that's what lets a newly-added override
  // correct a row an earlier run already wrote with the wrong wording.
  const overrideRows: Record<string, unknown>[] = [];
  const overridden = new Set<string>();
  for (const [source, hash] of distinct) {
    const text = overrideFor(source, to);
    if (text === null) continue;
    overridden.add(source);
    overrideRows.push({
      source_hash: hash,
      target_lang: to,
      source_lang: from,
      translated_text: text,
      char_count: source.length,
    });
  }

  // New or changed sources = those whose hash isn't cached yet. Overridden
  // sources never go to the API at all.
  const missing: string[] = [];
  for (const [source, hash] of distinct) {
    if (!cachedHashes.has(hash) && !overridden.has(source)) missing.push(source);
  }
  log(
    `[translate-work-orders] ${distinct.size} distinct, ${missing.length} new/changed, ${
      distinct.size - missing.length
    } cached`,
  );

  let translated = 0;
  if (missing.length > 0) {
    // Commit each batch as it lands. A full backfill is thousands of strings
    // and many minutes of paid API calls; collecting them all and writing once
    // at the end means any failure — a timeout, a rate limit, a killed worker —
    // throws away everything already translated and paid for. Per-batch upserts
    // make progress durable, and because the cache is content-addressed a
    // re-run simply resumes with whatever is still missing.
    const batches = chunked(missing, TRANSLATE_BATCH);
    const translator = deps.translator;
    // Langbly translates each segment serially inside a batch (~1.5s each), so
    // the wall clock is dominated by segment count, not round trips. Running a
    // few batches at once cuts a multi-hour backfill to minutes. The service
    // publishes no RPM limit and returns no rate-limit headers; six concurrent
    // requests were accepted cleanly, so this stays well under that.
    await inParallel(batches, deps.concurrency ?? TRANSLATE_CONCURRENCY, async (group) => {
      const outputs = await translator.translateBatch(group, from, to);
      const rows = group.map((source, i) => ({
        source_hash: textHash(source),
        target_lang: to,
        source_lang: from,
        translated_text: outputs[i],
        char_count: source.length,
      }));
      const { error } = await deps.supabase
        .from("work_order_translations")
        .upsert(rows, { onConflict: "source_hash,target_lang" });
      if (error) throw new Error(`upsert translations: ${error.message}`);
      translated += rows.length;
      log(`[translate-work-orders] ${translated}/${missing.length} translated`);
    });
  }

  // Apply curated overrides last so they win over anything the API produced.
  let overrodeCount = 0;
  for (let i = 0; i < overrideRows.length; i += DELETE_CHUNK) {
    const chunk = overrideRows.slice(i, i + DELETE_CHUNK);
    const { error } = await deps.supabase
      .from("work_order_translations")
      .upsert(chunk, { onConflict: "source_hash,target_lang" });
    if (error) throw new Error(`upsert overrides: ${error.message}`);
    overrodeCount += chunk.length;
  }
  if (overrodeCount > 0) log(`[translate-work-orders] applied ${overrodeCount} curated override(s)`);

  const reaped = await reapStale(deps.supabase, liveHashes);
  log(`[translate-work-orders] translated ${translated}, reaped ${reaped}`);
  return {
    distinctSources: distinct.size,
    alreadyCached: distinct.size - missing.length - overrideRows.length,
    overrides: overrodeCount,
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

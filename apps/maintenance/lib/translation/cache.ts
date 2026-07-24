import type { AppLanguage } from "@/lib/i18n";
import { mask, sentinelsIntact, unmask } from "@/lib/translation/mask";
import { textHash } from "@/lib/translation/hash";

/**
 * Pure translation-cache logic — the mask → translate → restore → verify pass,
 * with no zustand or storage coupling so it's directly testable. The store in
 * `lib/stores/translations.ts` is a thin persisted wrapper over these.
 *
 * Entries are keyed by `${lang}:${hash(source)}`, so an edited work order (new
 * source → new hash) re-translates while everything unchanged is a cache hit.
 * English is never stored; it IS the source.
 */

export type TranslationEntries = Record<string, string>;

/** Injectable translator; the store defaults it to the native Apple binding. */
export type BatchTranslate = (texts: string[], from: AppLanguage, to: AppLanguage) => Promise<string[]>;

export function translationKey(lang: AppLanguage, source: string): string {
  return `${lang}:${textHash(source)}`;
}

/** The translated form of `source` for `lang`, or null (untranslated / English). */
export function lookupTranslation(
  entries: TranslationEntries,
  lang: AppLanguage,
  source: string,
): string | null {
  if (lang === "en" || !source.trim()) return null;
  return entries[translationKey(lang, source)] ?? null;
}

/**
 * Drop entries whose source is no longer live, across every language.
 *
 * The cache is content-addressed: an edited or removed work order simply routes
 * to a different key, so a reader can never see a stale translation — but the
 * old entry is never read again either, and nothing else deletes it. Left alone
 * the store grows without bound as prose churns. This sweeps keys whose source
 * hash isn't among the current sources.
 *
 * Language-agnostic on purpose: keys are `${lang}:${hash}` and the hash is of
 * the (language-independent) source, so one live-hash set covers every target
 * language at once.
 *
 * Returns the same object when nothing is orphaned, so callers can skip a write.
 * Refuses to sweep against an empty `liveSources` — that's "data not loaded
 * yet", not "everything is dead", and acting on it would wipe the whole cache.
 */
export function reapOrphans(
  entries: TranslationEntries,
  liveSources: string[],
): TranslationEntries {
  if (liveSources.length === 0) return entries;

  const liveHashes = new Set<string>();
  for (const s of liveSources) {
    const text = s?.trim();
    if (text) liveHashes.add(textHash(text));
  }

  let removed = 0;
  const kept: TranslationEntries = {};
  for (const [key, value] of Object.entries(entries)) {
    // key = `${lang}:${hash}`; the hash is everything after the first ':'.
    const hash = key.slice(key.indexOf(":") + 1);
    if (liveHashes.has(hash)) kept[key] = value;
    else removed += 1;
  }
  return removed === 0 ? entries : kept;
}

/** Distinct, non-blank sources not already in `existing`, in first-seen order. */
export function pendingSources(
  lang: AppLanguage,
  sources: string[],
  existing: TranslationEntries,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const text = s?.trim();
    if (!text) continue;
    const key = translationKey(lang, text);
    if (existing[key] !== undefined || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Strings per native call.
 *
 * A property with thousands of work orders yields tens of thousands of sources,
 * and handing those to one `TranslationSession.translations(from:)` is a single
 * point of failure: it is slow enough to trip any watchdog, and one rejection
 * loses every string in it. Chunking bounds each call and makes progress
 * durable — a chunk that fails costs only its own strings.
 */
export const TRANSLATE_CHUNK = 200;

export function chunk<T>(items: T[], size: number = TRANSLATE_CHUNK): T[][] {
  if (size < 1) return items.length > 0 ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Translate the not-yet-cached sources and return ONLY the new entries to merge
 * (empty when nothing to do, the translator is unavailable, or every result
 * failed its placeholder-integrity check). Never throws.
 *
 * Chunks are sequential and independent: a failed chunk is skipped and the rest
 * still land, so a transient error degrades the result instead of erasing it.
 */
export async function computeTranslations(
  lang: AppLanguage,
  sources: string[],
  existing: TranslationEntries,
  translator: BatchTranslate,
  chunkSize: number = TRANSLATE_CHUNK,
  /**
   * Called with each chunk's entries as it lands. Thousands of sources take
   * minutes to work through; without this the caller sees nothing until the
   * last chunk, so a tech watching the screen gets English the whole time and
   * then everything at once. `sources` is ordered — what's on screen is first.
   */
  onChunk?: (entries: TranslationEntries) => void,
): Promise<TranslationEntries> {
  if (lang === "en") return {};
  const pending = pendingSources(lang, sources, existing);
  if (pending.length === 0) return {};

  const next: TranslationEntries = {};
  for (const group of chunk(pending, chunkSize)) {
    const masked = group.map((t) => mask(t));
    try {
      const translated = await translator(
        masked.map((m) => m.masked),
        "en",
        lang,
      );
      const landed: TranslationEntries = {};
      translated.forEach((out, i) => {
        const { tokens } = masked[i];
        // Reject a result that lost a placeholder — a protected part number may
        // have been dropped; keep English for that string instead.
        if (!sentinelsIntact(out, tokens.length)) return;
        landed[translationKey(lang, group[i])] = unmask(out, tokens);
      });
      Object.assign(next, landed);
      if (onChunk && Object.keys(landed).length > 0) onChunk(landed);
    } catch {
      // Unavailable / offline / timed out — skip this chunk, keep the rest.
      continue;
    }
  }
  return next;
}

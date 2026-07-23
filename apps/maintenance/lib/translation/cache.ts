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
 * Translate the not-yet-cached sources and return ONLY the new entries to merge
 * (empty when nothing to do, the translator is unavailable, or every result
 * failed its placeholder-integrity check). Never throws.
 */
export async function computeTranslations(
  lang: AppLanguage,
  sources: string[],
  existing: TranslationEntries,
  translator: BatchTranslate,
): Promise<TranslationEntries> {
  if (lang === "en") return {};
  const pending = pendingSources(lang, sources, existing);
  if (pending.length === 0) return {};

  const masked = pending.map((t) => mask(t));
  try {
    const translated = await translator(
      masked.map((m) => m.masked),
      "en",
      lang,
    );
    const next: TranslationEntries = {};
    translated.forEach((out, i) => {
      const { tokens } = masked[i];
      // Reject a result that lost a placeholder — a protected part number may
      // have been dropped; keep English for that string instead.
      if (!sentinelsIntact(out, tokens.length)) return;
      next[translationKey(lang, pending[i])] = unmask(out, tokens);
    });
    return next;
  } catch {
    // Unavailable / offline / pack missing — nothing new; render English.
    return {};
  }
}

import type { AppLanguage } from "@/lib/i18n";

/**
 * Routing for bidirectional, auto-detected translation.
 *
 * Prose reaches a tech in whatever language it was written — ResMan work orders
 * in English, a previous tech's notes possibly in Spanish. The reader wants all
 * of it in their app language. So each string is detected, and only those in a
 * *different* supported language are translated, each from its own source
 * language toward the reader. Strings already in the reader's language, or in a
 * language the app doesn't handle, or undetermined, are left untouched.
 *
 * Pure and framework-free; the detector and translator are injected.
 */

/** The languages the app both displays and translates between. */
export const SUPPORTED_LANGS: readonly AppLanguage[] = ["en", "es"];

/**
 * Collapse a BCP-47 / NL code to one of the app's languages, or null.
 * "en", "en-US", "en_GB" → "en"; "es", "es-419", "es_MX" → "es"; else null
 * (including "und", "pt", "zh" — anything the app can't render or translate).
 */
export function normalizeLang(code: string): AppLanguage | null {
  const base = code.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LANGS as readonly string[]).includes(base) ? (base as AppLanguage) : null;
}

export interface TranslationGroup {
  from: AppLanguage;
  texts: string[];
}

/**
 * Group sources that need translating toward `target`, keyed by source language.
 *
 * A source is translated only when its detected language normalizes to a
 * supported language that isn't `target`. `sources` and `detected` are parallel
 * arrays; a length mismatch is treated as "detect nothing" (translate none),
 * because acting on misaligned detection would translate strings from the wrong
 * language. Order within each group follows first appearance, so priority
 * ordering upstream is preserved.
 */
export function planTranslation(
  sources: string[],
  detected: string[],
  target: AppLanguage,
): TranslationGroup[] {
  if (sources.length !== detected.length) return [];

  const byLang = new Map<AppLanguage, string[]>();
  for (let i = 0; i < sources.length; i += 1) {
    const from = normalizeLang(detected[i]);
    if (from === null || from === target) continue;
    const bucket = byLang.get(from) ?? [];
    bucket.push(sources[i]);
    byLang.set(from, bucket);
  }
  return [...byLang.entries()].map(([from, texts]) => ({ from, texts }));
}

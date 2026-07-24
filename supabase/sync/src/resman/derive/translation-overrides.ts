import type { Lang } from "./translation-routing";

/**
 * Curated translations for trade jargon the machine translator gets wrong.
 *
 * Langbly is LLM-backed (Gemma) and handles full-sentence prose well — it only
 * fails on bare jargon tokens that carry no sentence context to disambiguate
 * them. Its API is Google Translate v2-compatible, which has no glossary
 * support (that's a v3 feature), so the correction has to live here.
 *
 * Verified failures on this property's corpus:
 *   "Punch"                    → "Puñetazo"   (a physical blow — not a punch list)
 *   "Rekey and reassign Traka" → "Reingresar" (re-login — not changing a cylinder)
 * Between them those two titles cover ~328 work orders, so a tech would meet
 * them constantly.
 *
 * Overrides are re-applied on every sync regardless of what's cached, so adding
 * an entry here corrects rows a previous run already wrote.
 */

export interface TranslationOverride {
  /** Matched case-insensitively against the trimmed source text. */
  source: string;
  lang: Lang;
  text: string;
}

export const TRANSLATION_OVERRIDES: readonly TranslationOverride[] = [
  // Punch list — the make-ready walkthrough, not violence.
  { source: "Punch", lang: "es", text: "Repaso (punch list)" },
  { source: "Punch List", lang: "es", text: "Lista de repaso (punch list)" },
  // Rekey — changing the lock cylinder. Traka is a brand; leave it alone.
  { source: "Rekey and reassign Traka", lang: "es", text: "Cambiar cerradura y reasignar Traka" },
  { source: "Rekey", lang: "es", text: "Cambiar cerradura" },
];

const byKey = new Map<string, string>(
  TRANSLATION_OVERRIDES.map((o) => [`${o.lang}:${o.source.trim().toLowerCase()}`, o.text]),
);

/** The curated translation for this source, or null when there isn't one. */
export function overrideFor(source: string, lang: Lang): string | null {
  return byKey.get(`${lang}:${source.trim().toLowerCase()}`) ?? null;
}

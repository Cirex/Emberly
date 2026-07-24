/**
 * Pure routing for the server-side translation pre-cache — which sources to
 * translate and in which direction, given each source's detected language.
 *
 * A source is translated only when its detected language is supported and
 * differs from its target. We produce exactly one row per source: an English
 * work order → its Spanish translation; a Spanish note → its English one. The
 * device reads those under `${targetLang}:${hash(source)}` and never
 * re-translates. Detection and target selection are the whole decision, so
 * they live here, framework-free and tested.
 */

export type Lang = "en" | "es";
const SUPPORTED: readonly Lang[] = ["en", "es"];

export function normalizeLang(code: string): Lang | null {
  const base = code.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED as readonly string[]).includes(base) ? (base as Lang) : null;
}

function otherLang(l: Lang): Lang {
  return l === "en" ? "es" : "en";
}

export interface PlannedTranslation {
  source: string;
  from: Lang;
  to: Lang;
}

/**
 * Given parallel `sources` and their `detected` codes, return what to translate.
 * Sources whose language is unsupported or undetermined are dropped (translated
 * nowhere) — the caller neither writes nor re-detects them beyond this run. A
 * length mismatch yields nothing rather than pairing a source with the wrong
 * language.
 */
export function planServerTranslations(sources: string[], detected: string[]): PlannedTranslation[] {
  if (sources.length !== detected.length) return [];
  const plans: PlannedTranslation[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    const from = normalizeLang(detected[i]);
    if (from === null) continue;
    plans.push({ source: sources[i], from, to: otherLang(from) });
  }
  return plans;
}

/** Group planned translations by direction, preserving first-seen order. */
export function groupByDirection(
  plans: PlannedTranslation[],
): { from: Lang; to: Lang; sources: string[] }[] {
  const groups = new Map<string, { from: Lang; to: Lang; sources: string[] }>();
  for (const p of plans) {
    const key = `${p.from}->${p.to}`;
    const g = groups.get(key) ?? { from: p.from, to: p.to, sources: [] };
    g.sources.push(p.source);
    groups.set(key, g);
  }
  return [...groups.values()];
}

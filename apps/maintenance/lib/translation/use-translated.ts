import { useCallback, useEffect } from "react";
import { useSettings } from "@/lib/stores/settings";
import { useTranslations } from "@/lib/stores/translations";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { lookupTranslation } from "@/lib/translation/cache";

export interface Translated {
  /** The text to render — the cached translation, or the source when there's none. */
  shown: string;
  /** True only when `shown` is a translation (drives the badge + "view original"). */
  translated: boolean;
}

/**
 * Returns `tr(source)` yielding the cached translation for the active language,
 * or the source itself (flagged untranslated) when the language is English, the
 * source is blank, or nothing is cached yet. Re-renders when translations land
 * or the language changes.
 */
export function useTranslated(): (source: string) => Translated {
  const language = useSettings((s) => s.language);
  const entries = useTranslations((s) => s.entries);
  return useCallback(
    (source: string): Translated => {
      if (language === "en" || !source) return { shown: source, translated: false };
      const hit = lookupTranslation(entries, language, source);
      return hit !== null ? { shown: hit, translated: true } : { shown: source, translated: false };
    },
    [language, entries],
  );
}

/**
 * Pre-translates every work order's prose (title, description, tech notes) into
 * the active language as it syncs — mounted once (the tabs layout). English is a
 * no-op; the cache dedupes and skips anything unchanged, so it's safe to run on
 * every data refresh and language switch.
 */
export function useWorkOrderTranslationSync(): void {
  const language = useSettings((s) => s.language);
  const dataVersion = useWorkOrders((s) => s.dataVersion);
  useEffect(() => {
    if (language === "en") return;
    const orders = useWorkOrders.getState().workOrders;
    const sources: string[] = [];
    for (const o of orders) {
      if (o.title) sources.push(o.title);
      if (o.notes) sources.push(o.notes);
      if (o.completion_notes) sources.push(o.completion_notes);
    }
    if (sources.length > 0) void useTranslations.getState().translate(language, sources);
    // dataVersion changes only when rows actually change, so this fires on real
    // syncs and language switches — not on every render.
  }, [language, dataVersion]);
}

import { useCallback, useEffect } from "react";
import { fetchWorkOrderTranslations } from "@/lib/api/work-order-translations";
import { useConfig } from "@/lib/stores/config";
import { useMyDay } from "@/lib/stores/my-day";
import { useSettings } from "@/lib/stores/settings";
import { useTranslations } from "@/lib/stores/translations";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { lookupTranslation } from "@/lib/translation/cache";
import { orderedTranslationSources } from "@/lib/translation/sources";

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
      // No English short-circuit any more — an English reader still gets the
      // Spanish prose translated. A source already in the reader's language has
      // no cache entry and falls through to itself.
      if (!source) return { shown: source, translated: false };
      const hit = lookupTranslation(entries, language, source);
      return hit !== null ? { shown: hit, translated: true } : { shown: source, translated: false };
    },
    [language, entries],
  );
}

/**
 * Keeps work-order prose translated, server-first.
 *
 * The sync worker pre-translates every ResMan work order once (Langbly) into
 * work_order_translations, keyed by the same content hash this app uses. So the
 * phone's job is to MERGE that, not to reproduce it — the bulk on-device
 * backfill that used to grind through thousands of strings is gone.
 *
 * What stays on-device is the prose the server has never seen: notes a tech
 * types in the field, including a Spanish speaker writing Spanish into
 * technician notes. After the merge, whatever is still uncached is exactly that
 * residue, and only it goes to Apple's translator.
 *
 * Nothing is re-translated without cause. The server pull is incremental (a
 * watermark, so an unchanged corpus returns an empty map and writes nothing),
 * and the on-device pass is content-addressed — a source whose hash is already
 * cached is skipped, and a source whose text changed hashes differently and is
 * the only thing that re-translates.
 */
export function useWorkOrderTranslationSync(): void {
  const language = useSettings((s) => s.language);
  const dataVersion = useWorkOrders((s) => s.dataVersion);
  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);
  // Today's stops are what the tech is actually looking at, so their prose goes
  // to the front of whatever residue still needs local translation.
  const stops = useMyDay((s) => s.stops);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orders = useWorkOrders.getState().workOrders;
      const priorityIds = useMyDay.getState().stops.flatMap((s) => s.workOrderIds);
      // EVERY live source, used only to decide what is still referenced.
      const sources = orderedTranslationSources(orders, priorityIds);
      if (sources.length === 0) return;

      // Evict translations of prose no longer present, so edited or closed work
      // orders don't accumulate dead entries. This needs the FULL set — reaping
      // against a subset would throw away good server translations for every
      // work order that happens not to be visible right now.
      useTranslations.getState().reap(sources);

      // 1. Server first — one small request, and nothing to translate locally
      //    for anything it covers.
      if (token && baseUrl) {
        try {
          const since = useTranslations.getState().serverSyncedAt[language] ?? null;
          const pulled = await fetchWorkOrderTranslations(language, since, { baseUrl, token });
          if (cancelled) return;
          useTranslations.getState().mergeServer(language, pulled.entries, pulled.syncedAt);
        } catch {
          // Offline or the endpoint is unreachable: keep what's cached and let
          // the on-device pass below cover whatever it can. Never a hard error.
        }
      }
      if (cancelled) return;

      // 2. On-device, for VISIBLE work only — never the whole corpus.
      //
      // This used to be handed `sources`, i.e. every work order's prose: ~4,000
      // orders x 3 fields is ~12,000 strings pushed at Apple's translator on
      // every sync. The comment above this block claimed the bulk backfill was
      // "gone"; it was not, and it is what produced the background
      // "translation timed out" failures.
      //
      // It was also redundant. The sync worker pre-translates that same ResMan
      // corpus (supabase/sync jobs/translate-work-orders.ts) and step 1 merges
      // it, so the tail was re-doing server work locally, slowly, on a phone.
      //
      // What genuinely needs on-device translation is prose the server has never
      // seen — a Spanish speaker typing into technician notes — and that lives
      // on the work order in front of the tech. So the local pass covers the
      // visible set: today's stops. `translate` still skips anything already
      // cached, so in the steady state this really is a no-op now.
      const visibleSources = orderedTranslationSources(
        orders.filter((o) => priorityIds.includes(o.resman_work_order_id)),
        priorityIds,
      );
      if (visibleSources.length > 0) {
        await useTranslations.getState().translate(language, visibleSources);
      }
    })();
    return () => {
      cancelled = true;
    };
    // dataVersion changes only when rows actually change, so this fires on real
    // syncs and language switches — not on every render. `stops` is read for its
    // identity: a rebuilt day reorders the residue toward the new visible work.
  }, [language, dataVersion, stops, token, baseUrl]);
}

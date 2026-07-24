import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AppLanguage } from "@/lib/i18n";
import {
  computeTranslations,
  lookupTranslation,
  type BatchTranslate,
  type TranslationEntries,
} from "@/lib/translation/cache";

/**
 * Floor on how often a backfill writes to the store. Each write re-renders
 * every screen reading translated prose, so the long tail is coalesced rather
 * than published chunk by chunk. Zero delay for the first chunk — see below.
 */
const COMMIT_INTERVAL_MS = 3_000;

/** Guards against two overlapping passes requesting the same sources. */
let running = false;

export type { BatchTranslate } from "@/lib/translation/cache";

/**
 * On-device translation cache for work-order prose (mockup: "translated during
 * sync, unchanged stays cached"). A thin persisted wrapper over the pure logic
 * in `lib/translation/cache.ts`. English is never stored; `lookup` returns null
 * for it so callers render the source.
 */

/** Lazily loads the native binding only when actually invoked, so the store never
 *  eagerly pulls `expo-modules-core` into non-native runtimes. */
const defaultTranslator: BatchTranslate = async (texts, from, to) => {
  const { translateBatchOrTimeout } = await import("@/lib/translation/native");
  // Bounded: a session the OS never starts would otherwise leave this promise
  // pending forever, which reads on screen as "nothing needed translating".
  return translateBatchOrTimeout(texts, from, to);
};

interface TranslationsState {
  entries: TranslationEntries;
  lookup: (lang: AppLanguage, source: string) => string | null;
  /** Translate every not-yet-cached source into `lang` and store the results.
   *  Safe to call every sync; deduped, batched, and never throws. */
  translate: (lang: AppLanguage, sources: string[], translator?: BatchTranslate) => Promise<void>;
  clear: () => void;
}

export const useTranslations = create<TranslationsState>()(
  persist(
    (set, get) => ({
      entries: {},
      lookup: (lang, source) => lookupTranslation(get().entries, lang, source),
      translate: async (lang, sources, translator = defaultTranslator) => {
        // One pass at a time. A sync tick and a language switch can both fire,
        // and a second pass computed against the same snapshot would re-request
        // everything the first is already working through.
        if (running) return;
        running = true;

        // Commit is coalesced, not per-chunk. `entries` is a new object on every
        // write and every useTranslated consumer reads it, so a write is a
        // re-render of every list showing work-order prose — hundreds of chunks
        // would mean hundreds of redraws. The first chunk lands immediately
        // (that's the visible work, ordered to the front); the long backfill
        // behind it commits at most once per COMMIT_INTERVAL_MS.
        let buffer: TranslationEntries = {};
        let lastCommit = 0;
        const commit = () => {
          if (Object.keys(buffer).length === 0) return;
          const landed = buffer;
          buffer = {};
          lastCommit = Date.now();
          set((state) => ({ entries: { ...state.entries, ...landed } }));
        };

        try {
          await computeTranslations(lang, sources, get().entries, translator, undefined, (landed) => {
            Object.assign(buffer, landed);
            if (Date.now() - lastCommit >= COMMIT_INTERVAL_MS) commit();
          });
        } finally {
          commit(); // whatever the last window collected, plus anything on failure
          running = false;
        }
      },
      clear: () => set({ entries: {} }),
    }),
    {
      name: "emberly-maintenance-translations",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
);

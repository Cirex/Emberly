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
  const { translateBatch } = await import("@/lib/translation/native");
  return translateBatch(texts, from, to);
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
        const next = await computeTranslations(lang, sources, get().entries, translator);
        if (Object.keys(next).length > 0) {
          set((state) => ({ entries: { ...state.entries, ...next } }));
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

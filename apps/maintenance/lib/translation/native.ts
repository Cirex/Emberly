import { requireOptionalNativeModule } from "expo";
import type { AppLanguage } from "@/lib/i18n";

/**
 * JS binding for the on-device Apple Translation native module
 * (`modules/emberly-translate`). Optional by design: `requireOptionalNativeModule`
 * returns null when the module isn't linked (Expo Go, a JS-only test run, or a
 * build that predates the module), and on Android where Apple's framework has no
 * twin. Every entry point degrades to "unavailable / no translation" so the app
 * keeps working and callers fall back to the English source.
 */

/** Whether the OS can translate the pair right now. `supported` = downloadable;
 *  `installed` = the language pack is present and translation runs offline. */
export type TranslateAvailability = "installed" | "supported" | "unsupported";

interface EmberlyTranslateNative {
  availability(from: string, to: string): Promise<TranslateAvailability>;
  /** Batch translate; returns one string per input, in order. */
  translateBatch(texts: string[], from: string, to: string): Promise<string[]>;
}

const native = requireOptionalNativeModule<EmberlyTranslateNative>("EmberlyTranslate");

/** Thrown when the platform can't translate — the store treats it as "skip and
 *  keep English", never a hard error. */
export class TranslateUnavailableError extends Error {
  constructor(message = "On-device translation is unavailable") {
    super(message);
    this.name = "TranslateUnavailableError";
  }
}

export function isTranslateModuleLinked(): boolean {
  return native != null;
}

export async function translateAvailability(
  from: AppLanguage,
  to: AppLanguage,
): Promise<TranslateAvailability> {
  if (!native) return "unsupported";
  try {
    return await native.availability(from, to);
  } catch {
    return "unsupported";
  }
}

/**
 * Batch-translate `texts` from → to. Throws `TranslateUnavailableError` when the
 * module is absent or the language pair can't be translated — never returns the
 * inputs unchanged, so English is never mistaken for a translation and cached.
 */
export async function translateBatch(
  texts: string[],
  from: AppLanguage,
  to: AppLanguage,
): Promise<string[]> {
  if (!native) throw new TranslateUnavailableError();
  const result = await native.translateBatch(texts, from, to);
  if (!Array.isArray(result) || result.length !== texts.length) {
    throw new TranslateUnavailableError("Translation returned an unexpected shape");
  }
  return result;
}

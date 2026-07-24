import type { AppLanguage } from "@/lib/i18n";
import type { TranslateAvailability } from "@/lib/translation/native";

/**
 * Why work-order prose didn't translate, in words a tech can act on.
 *
 * The translation path is deliberately forgiving — `computeTranslations` never
 * throws, so a failed batch just leaves the English source on screen. That is
 * the right behaviour for a sync tick and the wrong behaviour for the moment
 * someone switches the app to Spanish and nothing happens: the feature and its
 * absence look identical. This turns the silence into a sentence.
 *
 * Mirrors lib/dictation/availability-notice.ts, for the same reason.
 */

export interface TranslateNotice {
  title: string;
  body: string;
}

export interface TranslateNoticeInput {
  availability: TranslateAvailability;
  /** Whether the EmberlyTranslate native module is present in this binary. */
  moduleLinked: boolean;
  platform: string;
}

/**
 * Whether switching to this language should even check translation.
 * English renders ResMan prose as-authored, so there is nothing to report.
 */
export function shouldCheckTranslation(language: AppLanguage, platform: string): boolean {
  return language !== "en" && platform === "ios";
}

/**
 * The message to show after a language switch, or null when prose will
 * translate. `supported` is not silent: the pack downloads on first use, and a
 * tech who sees English for a minute should know why.
 */
export function translateNotice(input: TranslateNoticeInput): TranslateNotice | null {
  if (input.availability === "installed") return null;

  if (input.availability === "supported") {
    return {
      title: "Downloading the language pack",
      body: "iOS is fetching the Spanish translation pack. Work orders stay in English until it finishes — this happens once.",
    };
  }

  if (!input.moduleLinked) {
    return {
      title: "This build predates translation",
      body: "The app on this device was installed before on-device translation shipped. Reinstall the app to get it.",
    };
  }

  return {
    title: "Translation isn't available here",
    body: "This device can't translate English to Spanish on-device. Work orders will stay in English; the rest of the app is still translated.",
  };
}

import { requireOptionalNativeModule } from "expo";
import type { AppLanguage } from "@/lib/i18n";

/** Structural stand-in for expo-modules-core's DictationSubscription, which TS
 *  can't resolve from this app's module layout (same reason the translation
 *  binding imports `requireOptionalNativeModule` from `expo` rather than core). */
export interface DictationSubscription {
  remove(): void;
}

/**
 * JS binding for the on-device speech native module (`modules/emberly-speech`).
 *
 * Optional by design, exactly like the translation binding:
 * `requireOptionalNativeModule` returns null when the module isn't linked (Expo
 * Go, a JS-only test run, a build predating the module) and on Android, where
 * Apple's Speech framework has no twin. Every entry point degrades to
 * "unavailable", so the editor simply doesn't offer a mic rather than throwing.
 */

/**
 * - `ready` — permission granted and an on-device model is present
 * - `needsPermission` — usable, but access hasn't been asked for yet
 * - `denied` — the user said no; the app must not re-prompt, only point at Settings
 * - `unsupported` — no recognizer, no on-device model, or no native module
 */
export type DictationAvailability = "ready" | "needsPermission" | "denied" | "unsupported";

export interface DictationResult {
  text: string;
  isFinal: boolean;
}

interface EmberlySpeechNative {
  availability(locale: string): Promise<DictationAvailability>;
  requestPermissions(): Promise<DictationAvailability>;
  start(locale: string): Promise<void>;
  stop(): Promise<void>;
  addListener(event: "onResult", listener: (e: DictationResult) => void): DictationSubscription;
  addListener(event: "onError", listener: (e: { message: string }) => void): DictationSubscription;
}

const native = requireOptionalNativeModule<EmberlySpeechNative>("EmberlySpeech");

export function isDictationModuleLinked(): boolean {
  return native != null;
}

/** BCP-47 locale for the recognizer. The app's language picker is the source of
 *  truth, so a tech switched to Spanish dictates in Spanish. */
export function dictationLocale(language: AppLanguage): string {
  return language === "es" ? "es-US" : "en-US";
}

export async function dictationAvailability(language: AppLanguage): Promise<DictationAvailability> {
  if (!native) return "unsupported";
  try {
    return await native.availability(dictationLocale(language));
  } catch {
    return "unsupported";
  }
}

export async function requestDictationPermissions(): Promise<DictationAvailability> {
  if (!native) return "unsupported";
  try {
    return await native.requestPermissions();
  } catch {
    return "unsupported";
  }
}

export async function startDictation(language: AppLanguage): Promise<void> {
  if (!native) throw new Error("Dictation is unavailable on this device");
  await native.start(dictationLocale(language));
}

export async function stopDictation(): Promise<void> {
  if (!native) return;
  try {
    await native.stop();
  } catch {
    // Stopping a session that already ended is not a failure worth surfacing.
  }
}

export function onDictationResult(listener: (e: DictationResult) => void): DictationSubscription | null {
  return native?.addListener("onResult", listener) ?? null;
}

export function onDictationError(listener: (e: { message: string }) => void): DictationSubscription | null {
  return native?.addListener("onError", listener) ?? null;
}

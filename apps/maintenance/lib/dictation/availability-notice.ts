import type { DictationAvailability } from "@/lib/dictation/native";

/**
 * Why the mic can't be used, in words a tech can act on.
 *
 * The editor used to hide the mic whenever availability wasn't usable, which
 * collapsed four very different situations into one invisible control — a
 * device that needs a Settings toggle looked exactly like a build that shipped
 * without the native module. Neither the tech nor anyone debugging it could
 * tell which. So the button now always renders on iOS and explains itself.
 *
 * `moduleLinked` is the one signal that separates "this binary is too old"
 * from "this device said no", and it costs nothing to read.
 */

export interface DictationNotice {
  title: string;
  body: string;
}

export interface DictationNoticeInput {
  availability: DictationAvailability;
  /** Whether the EmberlySpeech native module is present in this binary. */
  moduleLinked: boolean;
  /** "ios" | "android" | anything else RN reports. */
  platform: string;
}

/**
 * Whether the mic should appear at all. Android has no Apple Speech twin, so
 * the control stays hidden there rather than shipping a button that can only
 * ever apologise.
 */
export function shouldOfferDictation(input: DictationNoticeInput): boolean {
  return input.platform === "ios";
}

/** Whether pressing the mic starts a session rather than explaining itself. */
export function canDictate(availability: DictationAvailability): boolean {
  return availability === "ready" || availability === "needsPermission";
}

/**
 * The message to show when the mic is pressed and can't run.
 * Returns null when dictation is usable — the caller should start a session.
 */
export function dictationNotice(input: DictationNoticeInput): DictationNotice | null {
  if (canDictate(input.availability)) return null;

  if (input.availability === "denied") {
    return {
      title: "Dictation is turned off",
      body: "Emberly needs Speech Recognition and Microphone access. Turn them on in Settings › Emberly Maintenance, then try again.",
    };
  }

  // Everything below is "unsupported", which has two very different causes.
  if (!input.moduleLinked) {
    return {
      title: "This build predates dictation",
      body: "The app on this device was installed before on-device dictation shipped. Reinstall the app to get it.",
    };
  }

  return {
    title: "Dictation isn't available here",
    body: "This device has no on-device speech model for the app's language. Enable Dictation in Settings › General › Keyboard, then reopen the notes.",
  };
}

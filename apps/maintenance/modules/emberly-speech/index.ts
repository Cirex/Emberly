/**
 * Local Expo module: on-device Apple speech recognition for Emberly Maintenance.
 *
 * The native module registers under the name `EmberlySpeech` (see the Swift
 * `Name(...)`). The app talks to it through the typed, fallback-safe binding in
 * `lib/dictation/native.ts` — import from there, not from this entry point, so
 * JS-only runtimes (tests, Expo Go, Android) degrade cleanly.
 */
export {} from "@/lib/dictation/native";

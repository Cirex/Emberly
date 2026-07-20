/**
 * Internal bill-list support: the profiling helper and small formatting
 * utilities the bill-list files share.
 *
 * Ports:
 *   - MLGWScriptEnvironment.swift `logProfileDuration` — the foundation `env.ts`
 *     ported `profileLog`/`formattedDuration`/`formattedProfileRate` but not this
 *     `Date`-based timer, so it lives here (bill-list is the only caller group).
 *     Swift measured a `Date` start; here the caller passes `Date.now()` (ms) and
 *     the return value is the elapsed **milliseconds**.
 *   - Swift `Int.formatted()` -> `formattedCount` (grouping separators).
 */

import { formattedDuration, profileLog } from "../env";

/**
 * Log a `[Profile]` line for `stage` with its elapsed time and optional
 * metadata, returning the elapsed milliseconds. Port of the Swift
 * `@discardableResult logProfileDuration(_:startedAt:metadata:)`.
 */
export function logProfileDuration(stage: string, startedAtMs: number, metadata = ""): number {
  const elapsed = Date.now() - startedAtMs;
  const suffix = metadata.length === 0 ? "" : ` | ${metadata}`;
  profileLog(`${stage} ${formattedDuration(elapsed)}${suffix}`);
  return elapsed;
}

/** Group-separated integer, matching Swift `Int.formatted()` (en-US grouping). */
export function formattedCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** UTF-8 byte length of `text` — the analog of Swift `String.utf8.count`. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Unicode-scalar string ordering, matching Swift `String`'s `<` used in the
 * `.sorted { $0 < $1 }` calls (a plain code-unit compare, not locale-aware).
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

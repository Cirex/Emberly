/**
 * MLGW download-stage timing/log helpers.
 *
 * Ports the two duration loggers from MLGWScriptEnvironment.swift that the
 * foundation `env.ts` did not expose:
 *   - logStageDuration  -> "<stage> completed in <duration>"
 *   - logProfileDuration -> "[Profile] <stage> <duration> | <metadata>"
 *
 * They build on the `debugLog` / `profileLog` / `formattedDuration` already in
 * `../env`. `startedAt` is a `Date.now()` millisecond timestamp (the Swift used a
 * `Date`); `logProfileDuration` returns the elapsed milliseconds so callers can
 * feed it straight into `formattedProfileRate`.
 *
 * ASSUMPTION/TODO(mlgw): these arguably belong in `../env` (or the `core` group)
 * next to `debugStage`/`profileLog`. They live here to keep the download group
 * self-contained; fold them into the shared logging home when the integrator
 * unifies logging.
 */

import { debugLog, formattedDuration, profileLog } from "../env";

/**
 * Log "<stage> completed in <duration>" and return the formatted duration. When
 * `reportToProgress` is set, the same message is also pushed to `progress`.
 * Port of `logStageDuration`.
 */
export function logStageDuration(
  stage: string,
  startedAt: number,
  progress?: (message: string) => void,
  reportToProgress = false,
): string {
  const duration = formattedDuration(Date.now() - startedAt);
  const message = `${stage} completed in ${duration}`;
  debugLog(message);
  if (reportToProgress) {
    progress?.(message);
  }
  return duration;
}

/**
 * Log a `[Profile]` line "<stage> <duration> | <metadata>" and return the
 * elapsed milliseconds. Port of `logProfileDuration`.
 */
export function logProfileDuration(stage: string, startedAt: number, metadata = ""): number {
  const elapsed = Date.now() - startedAt;
  const suffix = metadata.length === 0 ? "" : ` | ${metadata}`;
  profileLog(`${stage} ${formattedDuration(elapsed)}${suffix}`);
  return elapsed;
}

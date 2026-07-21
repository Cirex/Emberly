import type { StaffConfig } from "@/lib/stores/config";

/**
 * The one sync seam for the whole app. Feature stores self-register a sync
 * function at module import time:
 *
 *     registerSync("units", async (config) => { ...refresh... });
 *
 * and add their module to lib/sync-participants.ts (a side-effect import
 * barrel) so importing the barrel arms every participant. The tabs layout is
 * the only driver: it calls `runSyncTick(config)` on first run, every 60s
 * while the app is up, and whenever the app returns to the foreground.
 *
 * Contract for sync functions:
 * - Handle their own first-run vs quiet-refresh split (spinner only on a cold
 *   cache; silent refresh behind existing rows otherwise).
 * - NEVER throw for routine network failures — swallow and let the cached
 *   data stand (report via reportSyncFailed/reportSyncSucceeded). A rejection
 *   is still contained here (allSettled), but it should be the exception.
 * - Skip their state write when the server has nothing new, so a quiet tick
 *   re-renders nothing.
 */
export type SyncFn = (config: StaffConfig) => Promise<void>;

const registry = new Map<string, SyncFn>();

/**
 * Register (or replace) a named sync participant. Named so a hot-reloaded
 * module re-registering replaces itself instead of double-syncing.
 */
export function registerSync(name: string, fn: SyncFn): void {
  registry.set(name, fn);
}

/** Registered participant names, for diagnostics and tests. */
export function registeredSyncs(): string[] {
  return [...registry.keys()];
}

/** Remove a participant. Primarily for tests. */
export function unregisterSync(name: string): void {
  registry.delete(name);
}

/**
 * Run every registered sync once, concurrently. Never rejects: each
 * participant is isolated via Promise.allSettled, so one store's bad tick
 * can't starve the others.
 */
export async function runSyncTick(config: StaffConfig): Promise<void> {
  await Promise.allSettled([...registry.values()].map((fn) => fn(config)));
}

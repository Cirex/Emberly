import { RESIDENT_ACCESS_STALE_REASON } from '@emberly/core';
import { shouldLogoutForHeartbeatResult, type HeartbeatResult } from './sessionHeartbeat';

export function shouldRetryEntryTokenAfterHeartbeat(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'reason' in error
    && (error as { reason?: unknown }).reason === RESIDENT_ACCESS_STALE_REASON;
}

export interface CallWithAccessRetryOptions<T> {
  /** The API call to run (and to retry once after a successful heartbeat). */
  call: () => Promise<T>;
  /** Runs the ResMan heartbeat. Pass null when no ResMan session is available. */
  verifyAccess: (() => Promise<HeartbeatResult>) | null;
  /** Clears the local session when the heartbeat reports the session is invalid. */
  logout: () => Promise<void>;
  /** Error message surfaced to the user after a forced logout. */
  logoutMessage: string;
}

/**
 * Runs an authenticated API call and, if it fails because resident access is
 * stale, verifies the ResMan session once and retries.
 *
 * Logout only happens when the heartbeat definitively reports the session is
 * invalid. Heartbeat network failures ('unknown') never force a logout — the
 * original error is rethrown instead.
 */
export async function callWithAccessRetry<T>({
  call,
  verifyAccess,
  logout,
  logoutMessage,
}: CallWithAccessRetryOptions<T>): Promise<T> {
  try {
    return await call();
  } catch (err: unknown) {
    if (!verifyAccess || !shouldRetryEntryTokenAfterHeartbeat(err)) {
      throw err;
    }

    const heartbeat = await verifyAccess();
    if (shouldLogoutForHeartbeatResult(heartbeat)) {
      await logout();
      throw new Error(logoutMessage);
    }
    if (heartbeat.status !== 'valid') {
      // Offline or server error: keep the session and surface the original failure.
      throw err;
    }

    return call();
  }
}

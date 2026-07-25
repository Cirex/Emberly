import { useMetrics } from "@/lib/stores/metrics";
import { useTenantDetails } from "@/lib/stores/tenant-details";
import { useUnits } from "@/lib/stores/units";

/**
 * The resident data a deactivated scanner must stop carrying.
 *
 * Forgetting the scanner key made the device unusable but left everything it
 * had already pulled on disk in plain AsyncStorage: `tenant-details` is the
 * whole property's detail panes — names, phones, vehicles, plates, per unit —
 * plus the unit roster and the property counts. A gate iPad that gets
 * decommissioned, re-keyed for another property, or simply walks off is still
 * carrying the tenant list until someone deletes the app.
 *
 * DELIBERATELY NOT PURGED: the outbox stores — `photo-queue`, `annotations`,
 * `annotation-photos` and `tags`. Those hold work the guard did that the server
 * has not accepted yet, and `deactivate()` is also reached from
 * `handleUnauthorizedScannerKey()` on a plain 401 (a rotated or superseded
 * key). Purging there would destroy a guard's un-uploaded incident photos to
 * recover from a routine credential change. Re-keying the device re-syncs them.
 */
interface SessionStore {
  key: string;
  clear: () => void;
}

function sessionStore<T>(store: {
  getInitialState: () => T;
  setState: (state: T, replace: true) => void;
  persist: { clearStorage: () => void; getOptions: () => { name?: string } };
}): SessionStore {
  return {
    key: store.persist.getOptions().name ?? "",
    clear: () => {
      // Reset state before clearing storage, so nothing can re-persist the old
      // contents on the way out.
      store.setState(store.getInitialState(), true);
      store.persist.clearStorage();
    },
  };
}

const SESSION_STORES: SessionStore[] = [
  sessionStore(useMetrics),
  sessionStore(useTenantDetails),
  sessionStore(useUnits),
];

/** Storage keys this module clears, for the test that keeps the list honest. */
export const SESSION_STORE_KEYS = SESSION_STORES.map((store) => store.key);

/**
 * Drop the cached resident data — from disk AND from memory. Clearing storage
 * alone leaves the hydrated state in the running process, so the screens keep
 * rendering the old tenant list until the app is killed. Never rejects: a
 * deactivation must not be blocked by a disk error.
 */
export async function clearSessionData(): Promise<void> {
  await Promise.allSettled(SESSION_STORES.map(async (store) => store.clear()));
}

import { useMyDay } from "@/lib/stores/my-day";
import { usePm } from "@/lib/stores/pm";
import { useTranslations } from "@/lib/stores/translations";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";

/**
 * The property data a signed-out technician must stop carrying.
 *
 * The staff token lives in the Keychain and sign-out deletes it. What it
 * fetched does not go anywhere: these stores persist to AsyncStorage, plain
 * unencrypted JSON in the app container. Work-order descriptions and existing
 * tech notes routinely name the resident and describe the inside of their home;
 * the unit roster is the whole property. On a shared or handed-down phone the
 * next tech to sign in saw the previous one's property before the first sync
 * ran.
 *
 * `translations` goes too — it is a content-addressed cache, but what it caches
 * is that same prose in two languages.
 *
 * DELIBERATELY NOT PURGED — the outbox and the tech's own work:
 *   pending-edits, pending-closes, work-order-photos, photo-markup, job-time,
 *   annotations, annotation-photos, tags.
 * Those hold changes the server has not accepted yet. A sign-out is not an
 * abandonment of work, and destroying an offline tech's queued closes and
 * photos to tidy a cache would be a far worse bug than the one this fixes.
 * (Signing out with a non-empty outbox is worth surfacing in the UI — that is
 * a separate piece of work, not a reason to delete the queue here.)
 *
 * Also not purged, because they describe no resident: `settings`,
 * `work-orders-view`, `map-groups`, `utility-visibility`, `tour`.
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
  sessionStore(useMyDay),
  sessionStore(usePm),
  sessionStore(useTranslations),
  sessionStore(useUnits),
  sessionStore(useWorkOrders),
];

/** Storage keys this module clears, for the test that keeps the list honest. */
export const SESSION_STORE_KEYS = SESSION_STORES.map((store) => store.key);

/**
 * Drop the cached property data — from disk AND from memory. Clearing storage
 * alone leaves the hydrated state in the running process, so the screens keep
 * rendering the old work orders until the app is killed. Never rejects: a
 * sign-out must not be blocked by a disk error.
 */
export async function clearSessionData(): Promise<void> {
  await Promise.allSettled(SESSION_STORES.map(async (store) => store.clear()));
}

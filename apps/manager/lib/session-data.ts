import { useDelinquency } from "@/lib/stores/delinquency";
import { useInsurance } from "@/lib/stores/insurance";
import { useLeases } from "@/lib/stores/leases";
import { useLedger } from "@/lib/stores/ledger";
import { useMlgw } from "@/lib/stores/mlgw";
import { usePeople } from "@/lib/stores/people";
import { useRenewals } from "@/lib/stores/renewals";
import { useReports } from "@/lib/stores/reports";
import { useSnapshots } from "@/lib/stores/snapshots";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";

/**
 * Everything the signed-in manager pulled down, and how to get rid of it.
 *
 * The staff token lives in the Keychain and sign-out deletes it — but the DATA
 * it fetched does not. Every store below persists to AsyncStorage, which is
 * plain unencrypted JSON in the app container: the resident directory (names,
 * unit, phones, email, plates), the rent ledger, who is being evicted, lease
 * terms and rents, MLGW account numbers, owner reports. Signing out left all of
 * it on the device, so the next person to sign in — a new manager, a
 * transferred employee, whoever picks up a shared iPad — opened the app to the
 * previous session's residents before the first sync even ran.
 *
 * NOT listed here, on purpose: `settings`, `map-lens` and `map-groups`. Those
 * are device preferences (language, theme, which lens paints the map) and the
 * leasing filter DEFINITIONS — rules like "balance > $800", which describe no
 * resident. They survive a sign-out the way a keyboard layout does.
 */
interface SessionStore {
  /** The AsyncStorage key, so the test below can check this list is complete. */
  key: string;
  clear: () => void;
}

/**
 * Bind one persisted store. Generic so each store's own state type resolves at
 * the call site — the list itself is heterogeneous, and zustand's `setState`
 * overloads don't unify across it.
 */
function sessionStore<T>(store: {
  getInitialState: () => T;
  setState: (state: T, replace: true) => void;
  persist: { clearStorage: () => void; getOptions: () => { name?: string } };
}): SessionStore {
  return {
    key: store.persist.getOptions().name ?? "",
    clear: () => {
      // Order matters: reset state first so nothing can re-persist the old
      // contents on its way out, then clear what is already on disk.
      store.setState(store.getInitialState(), true);
      store.persist.clearStorage();
    },
  };
}

const SESSION_STORES: SessionStore[] = [
  sessionStore(useDelinquency),
  sessionStore(useInsurance),
  sessionStore(useLeases),
  sessionStore(useLedger),
  sessionStore(useMlgw),
  sessionStore(usePeople),
  sessionStore(useRenewals),
  sessionStore(useReports),
  sessionStore(useSnapshots),
  sessionStore(useUnits),
  sessionStore(useWorkOrders),
];

/** Storage keys this module clears, for the test that keeps the list honest. */
export const SESSION_STORE_KEYS = SESSION_STORES.map((store) => store.key);

/**
 * Drop every cached row for the signed-out session — from disk AND from memory.
 *
 * Both halves matter. Clearing storage alone leaves the hydrated state in the
 * running process, so the screens keep rendering the old resident list until
 * the app is killed; resetting state alone leaves the JSON on disk for the next
 * launch. Resolves even if a store's storage write fails: a sign-out must never
 * be blocked by a disk error, and the in-memory reset has already happened.
 */
export async function clearSessionData(): Promise<void> {
  await Promise.allSettled(SESSION_STORES.map(async (store) => store.clear()));
}

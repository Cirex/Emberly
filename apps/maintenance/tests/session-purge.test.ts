import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Sign-out used to delete the Keychain token and nothing else, leaving the
 * whole property cached in AsyncStorage — plain unencrypted JSON in the app
 * container. Work-order descriptions and existing tech notes routinely name the
 * resident and describe the inside of their home, so a handed-down phone showed
 * the next tech the previous one's property before the first sync ran.
 *
 * The purge is deliberately NOT total: the outbox holds work the server hasn't
 * accepted yet, and deleting an offline tech's queued closes and photos to tidy
 * a cache would be a worse bug than the one being fixed. Both halves of that
 * contract are asserted here, plus a completeness scan so a store added later
 * has to be classified one way or the other.
 */

const store = new Map<string, string>();

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

/**
 * Seed and read the persisted copy through THE STORE'S OWN storage adapter,
 * never through the Map above.
 *
 * `mock.module` writes to a process-global registry and the module cache is
 * shared across test files, so in a full-suite run the AsyncStorage instance a
 * store captured at import time is whichever mock was live when the FIRST file
 * imported it — not necessarily this one. Asserting on the local Map then checks
 * a backing store the purge never wrote to, and a passing guarantee reads as
 * broken. `persist.getOptions().storage` is by definition the same object
 * `clearStorage()` calls removeItem on.
 */
interface PersistedStore {
  persist: {
    getOptions: () => {
      name?: string;
      storage?: {
        getItem: (name: string) => Promise<unknown> | unknown;
        setItem: (name: string, value: unknown) => Promise<unknown> | unknown;
      };
    };
  };
}

async function seed(store: PersistedStore, state: unknown): Promise<void> {
  const { name, storage } = store.persist.getOptions();
  await storage!.setItem(name!, { state, version: 0 });
}

/** The persisted payload as text, so a resident's name can be searched for. */
async function persistedText(store: PersistedStore): Promise<string> {
  const { name, storage } = store.persist.getOptions();
  return JSON.stringify((await storage!.getItem(name!)) ?? "");
}

mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

const STORES_DIR = path.join(import.meta.dir, "..", "lib", "stores");

/**
 * Keys that SURVIVE a sign-out on purpose.
 *
 * The outbox and the tech's own work: a sign-out is not an abandonment of work.
 * Plus preferences and view state, which describe no resident.
 */
const SURVIVES_SIGN_OUT = new Set([
  // Outbox / the tech's own work.
  "emberly-maintenance-pending-edits",
  "emberly-maintenance-pending-closes",
  "emberly-maintenance-work-order-photos",
  "emberly-maintenance-photo-markup",
  "emberly-maintenance-job-time",
  // Preferences and view state.
  "emberly-maintenance-settings",
  "emberly-maintenance-wo-view",
  "emberly-maintenance-map-groups",
  "emberly-maintenance-utility-visibility",
  "emberly-maintenance-tour",
]);

function persistedKeys(): string[] {
  const keys: string[] = [];
  for (const file of readdirSync(STORES_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(path.join(STORES_DIR, file), "utf8");
    if (!source.includes("persist(")) continue;
    for (const match of source.matchAll(/name:\s*"(emberly-[a-z0-9-]+)"/g)) keys.push(match[1]);
  }
  return keys;
}

describe("sign-out purge", () => {
  beforeEach(() => store.clear());

  test("every persisted store is either purged or explicitly allowed to survive", async () => {
    const { SESSION_STORE_KEYS } = await import("@/lib/session-data");
    const purged = new Set(SESSION_STORE_KEYS);

    const found = persistedKeys();
    expect(found.length).toBeGreaterThanOrEqual(15);

    const unaccounted = found.filter((key) => !purged.has(key) && !SURVIVES_SIGN_OUT.has(key));
    expect(unaccounted).toEqual([]);
    expect(SESSION_STORE_KEYS.filter((key) => !found.includes(key))).toEqual([]);
  });

  test("clearSessionData drops cached work orders from memory and disk", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    const { clearSessionData } = await import("@/lib/session-data");

    useWorkOrders.setState({
      workOrders: [
        { id: "wo-1", unitNumber: "0712", description: "Leak under Ms. Alvarez's sink" },
      ] as never,
      refreshedAt: 1,
    });
    await seed(useWorkOrders as never, {
      workOrders: [{ id: "wo-1", description: "Leak under Ms. Alvarez's sink" }],
    });
    // The seed has to be visible before the purge, or the assertion below would
    // pass against an empty store and prove nothing.
    expect(await persistedText(useWorkOrders as never)).toContain("Alvarez");

    await clearSessionData();

    expect(useWorkOrders.getState().workOrders).toEqual([]);
    expect(await persistedText(useWorkOrders as never)).not.toContain("Alvarez");
  });

  test("the outbox is NOT purged — queued work outlives a sign-out", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    const { clearSessionData } = await import("@/lib/session-data");

    // A close the tech recorded with no signal, still waiting to be pushed.
    usePendingCloses.setState({
      pending: [{ workOrderId: "wo-9", note: "Replaced mixing valve" }] as never,
    });

    await clearSessionData();

    expect(usePendingCloses.getState().pending).toHaveLength(1);
  });

  test("the actions survive the reset, so the store still works after sign-in", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    const { clearSessionData } = await import("@/lib/session-data");
    await clearSessionData();
    expect(typeof useWorkOrders.getState().loadAll).toBe("function");
    expect(typeof useWorkOrders.getState().refresh).toBe("function");
  });
});

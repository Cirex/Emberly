import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Sign-out used to delete the Keychain token and nothing else.
 *
 * Every feature store persists to AsyncStorage — plain unencrypted JSON in the
 * app container — so the resident directory, the rent ledger, who is being
 * evicted, lease terms, MLGW account numbers and owner reports all survived a
 * sign-out. On a shared iPad the next manager to sign in opened the app to the
 * previous session's residents.
 *
 * Two things are checked here: that the purge really empties both disk and the
 * in-memory store, and that the list of stores it purges is COMPLETE — the
 * second is what stops store #12 from being added next year and quietly
 * skipped.
 */

const store = new Map<string, string>();

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

// The stores only fire telemetry; the real module reaches react-native's
// flow-typed entry, which bun can't parse.
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

const STORES_DIR = path.join(import.meta.dir, "..", "lib", "stores");

/**
 * Keys that SURVIVE a sign-out on purpose: device preferences and the leasing
 * filter definitions (rules like "balance > $800", which describe no resident).
 * Anything not here and not purged is a leak.
 */
const SURVIVES_SIGN_OUT = new Set([
  "emberly-manager-settings",
  "emberly-manager-map-lens",
  "emberly-manager-map-groups",
]);

/** Every `name:` a persist() config declares under lib/stores. */
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
    // A wrong directory or a changed persist() shape would make this vacuous.
    expect(found.length).toBeGreaterThanOrEqual(14);

    const unaccounted = found.filter((key) => !purged.has(key) && !SURVIVES_SIGN_OUT.has(key));
    expect(unaccounted).toEqual([]);
    // And the purge list must not name a key that no longer exists.
    expect(SESSION_STORE_KEYS.filter((key) => !found.includes(key))).toEqual([]);
  });

  test("clearSessionData empties both AsyncStorage and the live store", async () => {
    const { usePeople } = await import("@/lib/stores/people");
    const { clearSessionData } = await import("@/lib/session-data");

    // A hydrated session: the directory is in memory and on disk.
    usePeople.setState({
      index: [{ personLeaseId: "p1", displayName: "Marcus Sanders" }] as never,
      refreshedAt: 1,
    });
    await usePeople.persist.rehydrate();
    store.set(
      "emberly-manager-people",
      JSON.stringify({ state: { index: [{ personLeaseId: "p1" }] }, version: 0 }),
    );

    await clearSessionData();

    // Memory: nothing left to render.
    expect(usePeople.getState().index).toEqual([]);
    expect(usePeople.getState().refreshedAt).toBe(0);
    // Disk: nothing left to rehydrate on next launch. zustand writes the
    // reset state rather than removing the key, so an entry may remain — what
    // must not remain is the resident.
    expect(store.get("emberly-manager-people") ?? "").not.toContain("Marcus Sanders");
    expect(store.get("emberly-manager-people") ?? "").not.toContain("p1");
  });

  test("the actions survive the reset, so the store still works after sign-in", async () => {
    const { usePeople } = await import("@/lib/stores/people");
    const { clearSessionData } = await import("@/lib/session-data");
    await clearSessionData();
    // setState(..., true) REPLACES state — if the initial state didn't carry
    // the action functions, the next sign-in would crash on first sync.
    expect(typeof usePeople.getState().loadAll).toBe("function");
    expect(typeof usePeople.getState().revealPii).toBe("function");
  });
});

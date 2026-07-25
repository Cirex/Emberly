import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Deactivating a scanner used to forget the Keychain key and nothing else. The
 * device became unusable but kept everything it had pulled: `tenant-details` is
 * the whole property's detail panes — names, phones, vehicles, plates, per unit
 * — sitting in AsyncStorage as plain unencrypted JSON. A gate iPad that gets
 * decommissioned, re-keyed for another property, or simply walks off was still
 * carrying the tenant list.
 *
 * The purge stops at the outbox on purpose: `deactivate()` is also reached from
 * `handleUnauthorizedScannerKey()` on a plain 401 (a rotated key), and wiping a
 * guard's un-uploaded incident photos to recover from a routine credential
 * change would be far worse than the leak being fixed.
 */

const store = new Map<string, string>();

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

// The stores reach lib/api/*, which imports stores/config for
// handleUnauthorizedScannerKey — and that pulls expo-secure-store, whose
// dependency chain lands on react-native's flow-typed entry that bun can't
// parse. Nothing under test touches the Keychain.
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

const STORES_DIR = path.join(import.meta.dir, "..", "lib", "stores");

/** Preferences, which describe no resident. The outbox stores use manual keys. */
const SURVIVES_DEACTIVATION = new Set(["emberly-security-settings"]);

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

describe("deactivation purge", () => {
  beforeEach(() => store.clear());

  test("every persisted store is either purged or explicitly allowed to survive", async () => {
    const { SESSION_STORE_KEYS } = await import("@/lib/session-data");
    const purged = new Set(SESSION_STORE_KEYS);

    const found = persistedKeys();
    expect(found.length).toBeGreaterThanOrEqual(4);

    const unaccounted = found.filter((key) => !purged.has(key) && !SURVIVES_DEACTIVATION.has(key));
    expect(unaccounted).toEqual([]);
    expect(SESSION_STORE_KEYS.filter((key) => !found.includes(key))).toEqual([]);
  });

  test("clearSessionData drops the tenant detail panes from memory and disk", async () => {
    const { useTenantDetails } = await import("@/lib/stores/tenant-details");
    const { clearSessionData } = await import("@/lib/session-data");

    useTenantDetails.setState({
      byUnit: { "unit-1": { tenantNames: ["Marcus Sanders"], phones: ["901-555-0134"] } } as never,
      syncedAt: 1,
    });
    store.set(
      "emberly-security-tenant-details",
      JSON.stringify({
        state: { byUnit: { "unit-1": { tenantNames: ["Marcus Sanders"] } } },
        version: 0,
      }),
    );

    await clearSessionData();

    expect(useTenantDetails.getState().byUnit).toEqual({});
    expect(store.get("emberly-security-tenant-details") ?? "").not.toContain("Marcus Sanders");
    expect(store.get("emberly-security-tenant-details") ?? "").not.toContain("901-555-0134");
  });

  test("the actions survive the reset, so re-keying the device still syncs", async () => {
    const { useTenantDetails } = await import("@/lib/stores/tenant-details");
    const { clearSessionData } = await import("@/lib/session-data");
    await clearSessionData();
    expect(typeof useTenantDetails.getState().loadAll).toBe("function");
    expect(typeof useTenantDetails.getState().refreshUnit).toBe("function");
  });
});

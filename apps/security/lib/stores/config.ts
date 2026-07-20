import { PRODUCTION_ORIGIN } from "@emberly/core";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

// The scanner key lives in the Keychain-backed secure store, never in
// AsyncStorage (same posture as the iOS KeychainCredentialStore).
//
// The key is SELF-IDENTIFYING: the server stores a deterministic HMAC of it, so
// it resolves the device from the key alone (the same model the API/MCP tokens
// use with their token hash). There is no scanner id to configure, and one key
// authenticates verify-pass, the ResMan units API, and the guest-pass feed — so
// the key is the only thing this device stores.
const K = {
  key: "emberly_scanner_key",
} as const;

// The origin is fixed at build time (Expo inlines EXPO_PUBLIC_* into the
// bundle), matching whatever the rest of the app talks to. It is deliberately
// not device-editable: a guard has no way to know a correct value, and a typo
// here bricks the device.
export const BASE_URL = process.env.EXPO_PUBLIC_BASE_URL || PRODUCTION_ORIGIN;

interface ConfigState {
  baseUrl: string;
  scannerKey: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  save: (next: { scannerKey: string }) => Promise<void>;
  /** Forget the stored key → the root gate falls back to the setup screen. */
  deactivate: () => Promise<void>;
}

export const useConfig = create<ConfigState>((set) => ({
  baseUrl: BASE_URL,
  scannerKey: "",
  hydrated: false,
  hydrate: async () => {
    const scannerKey = await SecureStore.getItemAsync(K.key);
    set({ scannerKey: scannerKey ?? "", hydrated: true });
  },
  save: async (next) => {
    const scannerKey = next.scannerKey.trim();
    await SecureStore.setItemAsync(K.key, scannerKey);
    set({ scannerKey });
  },
  deactivate: async () => {
    // Flip the in-memory key first so the root gate re-renders to `setup`
    // immediately, then purge the Keychain-backed store.
    set({ scannerKey: "" });
    await SecureStore.deleteItemAsync(K.key);
  },
}));

/**
 * Called by the API layer when the server REJECTS the stored key with HTTP 401
 * (the key is no longer recognized — e.g. it predates a backend change or the
 * scanner was removed). Clearing it lets the root layout fall back to the setup
 * screen so the device can be re-keyed, instead of stranding the guard on
 * "not authorized" error screens with no way out.
 *
 * Deliberately fires on 401 (authentication failed) only — NOT 403, which can
 * mean a valid key hit a resource it isn't scoped for and must not wipe the key.
 * Idempotent: repeated calls from concurrent in-flight requests are harmless.
 */
export function handleUnauthorizedScannerKey(): void {
  if (useConfig.getState().scannerKey) void useConfig.getState().deactivate();
}

/**
 * Everything the device does — verifying passes, the ResMan units API, and the
 * guest-pass feed — authenticates with the one self-identifying scanner key, so
 * all three become available as soon as it is set. The root layout is the only
 * caller: it withholds every view until this passes, so no screen has to check.
 */
export function isScannerConfigured(s: { scannerKey: string }): boolean {
  return s.scannerKey.trim().length > 0;
}

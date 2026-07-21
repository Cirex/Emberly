import { PRODUCTION_ORIGIN } from "@emberly/core";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

// The staff token lives in the Keychain-backed secure store, never in
// AsyncStorage. It is a per-user `eapi_` access token minted by
// POST /api/admin/auth/app-token at sign-in — the ResMan username/password are
// exchanged for it and never stored on the device.
//
// One token authenticates everything the app does: the ResMan read API
// (units and friends) via requireResmanApiKey, and the /api/admin/* routes via
// requireAdminOrScanner's token branch — with every action attributed to the
// signed-in staff member.
const K = {
  token: "emberly_staff_token",
  admin: "emberly_staff_admin",
} as const;

// The origin is fixed at build time (Expo inlines EXPO_PUBLIC_* into the
// bundle), matching whatever the rest of the app talks to. It is deliberately
// not device-editable.
export const BASE_URL = process.env.EXPO_PUBLIC_BASE_URL || PRODUCTION_ORIGIN;

export interface StaffAdmin {
  adminId: string;
  role: string;
  displayName: string;
  /** ResMan person GUID captured at login — a stable identity beyond the name. */
  personId?: string | null;
}

/** Everything an API call needs. */
export interface StaffConfig {
  baseUrl: string;
  token: string;
}

interface ConfigState {
  baseUrl: string;
  token: string;
  admin: StaffAdmin | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  signIn: (next: { token: string; admin: StaffAdmin }) => Promise<void>;
  signOut: () => Promise<void>;
}

function parseAdmin(raw: string | null): StaffAdmin | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StaffAdmin>;
    if (typeof v.adminId === "string" && typeof v.displayName === "string") {
      return {
        adminId: v.adminId,
        role: typeof v.role === "string" ? v.role : "viewer",
        displayName: v.displayName,
        personId: typeof v.personId === "string" ? v.personId : null,
      };
    }
  } catch {
    /* corrupted — treat as signed out */
  }
  return null;
}

export const useConfig = create<ConfigState>((set) => ({
  baseUrl: BASE_URL,
  token: "",
  admin: null,
  hydrated: false,
  hydrate: async () => {
    try {
      const [token, adminRaw] = await Promise.all([
        SecureStore.getItemAsync(K.token),
        SecureStore.getItemAsync(K.admin),
      ]);
      // DEV ONLY: a token baked into .env.local lets the SIMULATOR skip the
      // sign-in gate during development. Never on real hardware — a phone or
      // iPad always gets the real sign-in screen, even in debug builds. Dead
      // code in release builds (__DEV__ is compile-time), and inert unless
      // EXPO_PUBLIC_DEV_TOKEN is set. Remove before TestFlight.
      if (__DEV__ && !Device.isDevice && !token && process.env.EXPO_PUBLIC_DEV_TOKEN) {
        set({
          token: process.env.EXPO_PUBLIC_DEV_TOKEN,
          admin: { adminId: "dev", role: "super_admin", displayName: "Dev Preview" },
          hydrated: true,
        });
        return;
      }
      set({ token: token ?? "", admin: parseAdmin(adminRaw), hydrated: true });
    } catch (error) {
      // A Keychain read failing must land on the sign-in gate (signed out),
      // never leave the app stuck on a blank pre-hydration screen forever.
      console.warn("[config] hydrate failed; starting signed out:", error);
      set({ token: "", admin: null, hydrated: true });
    }
  },
  signIn: async ({ token, admin }) => {
    await Promise.all([
      SecureStore.setItemAsync(K.token, token.trim()),
      SecureStore.setItemAsync(K.admin, JSON.stringify(admin)),
    ]);
    set({ token: token.trim(), admin });
  },
  signOut: async () => {
    await Promise.all([SecureStore.deleteItemAsync(K.token), SecureStore.deleteItemAsync(K.admin)]);
    set({ token: "", admin: null });
  },
}));

/**
 * The root layout is the only caller: it withholds every view until this
 * passes, so no screen has to check.
 */
export function isSignedIn(s: { token: string }): boolean {
  return s.token.trim().length > 0;
}

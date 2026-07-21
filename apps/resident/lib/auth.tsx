import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import {
  loginResident,
  selectResident,
  verifySession,
  type EmberlySession,
  type EmberlyResidentIdentity,
  type ResidentOption,
  type ResidentDeviceSession,
  type ResmanSession,
} from "./api";
import {
  deleteLargeSecureItemAsync,
  getLargeSecureItemAsync,
  setLargeSecureItemAsync,
} from "./secureStoreChunks";
import {
  shouldLogoutForHeartbeatResult,
  shouldRunHeartbeat,
  type HeartbeatResult,
} from "./sessionHeartbeat";
import {
  getLocalUnlockAvailability,
  localUnlockErrorMessage,
  shouldLockAppForLocalUnlock,
  type LocalUnlockAvailability,
} from "./localUnlock";
import { normalizeUnitLabel } from "@emberly/core";
import { capture, identify, resetAnalytics } from "./analytics";

const TOKEN_KEY = "emberly_token";
const TENANT_ID_KEY = "emberly_tenant_id";
const NAME_KEY = "emberly_name";
const RESIDENT_ID_KEY = "emberly_resident_id";
const RESIDENT_IDENTITY_KEY = "emberly_resident_identity";
const RESMAN_SESSION_KEY = "emberly_resman_session";
const RESIDENT_DEVICE_SESSION_KEY = "emberly_resident_device_session";
const LOCAL_UNLOCK_ENABLED_KEY = "emberly_local_unlock_enabled";

// How often (ms) to re-check the session when the app comes to the foreground.
// Skip the check if the app was only backgrounded briefly.
const MIN_BACKGROUND_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

interface AuthContextValue {
  token: string | null;
  tenantId: string | null;
  residentId: string | null;
  resident: EmberlyResidentIdentity | null;
  name: string | null;
  deviceSession: ResidentDeviceSession | null;
  resmanSession: ResmanSession | null;
  pendingSelection: PendingResidentSelection | null;
  isLoading: boolean;
  isAppLocked: boolean;
  isLocalUnlocking: boolean;
  localUnlockEnabled: boolean;
  localUnlockAvailable: boolean;
  localUnlockLabel: string;
  localUnlockUnavailableReason: string | null;
  /**
   * Initiates sign-in. If the Resman account is shared across multiple residents,
   * this resolves with `{ requiresSelection: true, ... }` and the caller should
   * navigate to the resident picker screen. Otherwise it resolves with
   * `{ requiresSelection: false }` and the user is fully signed in.
   */
  login: (username: string, password: string) => Promise<LoginResult>;
  /**
   * Completes sign-in after the user picks themselves from the resident picker.
   */
  completeSelection: (selectionToken: string, residentId: string) => Promise<void>;
  enableLocalUnlock: () => Promise<void>;
  disableLocalUnlock: () => Promise<void>;
  unlockWithLocalAuth: () => Promise<boolean>;
  logout: () => Promise<void>;
}

export interface PendingResidentSelection {
  selectionToken: string;
  residents: ResidentOption[];
}

export type LoginResult =
  | { requiresSelection: false }
  | {
      requiresSelection: true;
      residents: ResidentOption[];
    };

const AuthContext = createContext<AuthContextValue | null>(null);

function isResidentIdentity(value: unknown): value is EmberlyResidentIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EmberlyResidentIdentity>;
  return (
    typeof candidate.residentId === "string" &&
    typeof candidate.tenantId === "string" &&
    typeof candidate.ledgerId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.unitId === "string" &&
    typeof candidate.unitNumber === "string"
  );
}

function parseStoredResidentIdentity(value: string | null): EmberlyResidentIdentity | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    return isResidentIdentity(parsed)
      ? {
          ...parsed,
          unitId: normalizeUnitLabel(parsed.unitId) || parsed.unitId,
          unitNumber: normalizeUnitLabel(parsed.unitNumber) || parsed.unitNumber,
        }
      : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [residentId, setResidentId] = useState<string | null>(null);
  const [resident, setResident] = useState<EmberlyResidentIdentity | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [deviceSession, setDeviceSession] = useState<ResidentDeviceSession | null>(null);
  const [resmanSession, setResmanSession] = useState<ResmanSession | null>(null);
  const [pendingSelection, setPendingSelection] = useState<PendingResidentSelection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAppLocked, setIsAppLocked] = useState(false);
  const [isLocalUnlocking, setIsLocalUnlocking] = useState(false);
  const [localUnlockEnabled, setLocalUnlockEnabled] = useState(false);
  const [localUnlockStatus, setLocalUnlockStatus] = useState<LocalUnlockAvailability>({
    available: false,
    label: "Face ID",
    unavailableReason: null,
  });
  const pendingResmanSession = useRef<ResmanSession | null>(null);
  const nextHeartbeatAfter = useRef<string | null>(null);

  // Track when the app last went to the background so we can skip trivial checks
  const lastBackgroundAt = useRef<number | null>(null);

  function rememberHeartbeatResult(result: HeartbeatResult) {
    if (result.status === "valid") {
      nextHeartbeatAfter.current = result.nextCheckAfter ?? null;
    } else if (result.status === "invalid") {
      nextHeartbeatAfter.current = null;
    }
  }

  async function refreshLocalUnlockAvailability(): Promise<LocalUnlockAvailability> {
    const [hasHardware, isEnrolled, authenticationTypes] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    const availability = getLocalUnlockAvailability({
      hasHardware,
      isEnrolled,
      authenticationTypes,
    });
    setLocalUnlockStatus(availability);
    return availability;
  }

  async function authenticateWithLocalUnlock(promptMessage: string): Promise<boolean> {
    const availability = await refreshLocalUnlockAvailability();
    if (!availability.available) {
      throw new Error(availability.unavailableReason ?? "Face ID is not available on this device.");
    }

    setIsLocalUnlocking(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage,
        cancelLabel: "Cancel",
        fallbackLabel: "Use Passcode",
        biometricsSecurityLevel: "strong",
      });

      if (result.success) return true;

      if (
        result.error === "user_cancel" ||
        result.error === "system_cancel" ||
        result.error === "app_cancel"
      ) {
        return false;
      }

      throw new Error(localUnlockErrorMessage(result.error));
    } finally {
      setIsLocalUnlocking(false);
    }
  }

  // ------------------------------------------------------------------
  // Restore session on cold launch
  // ------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [
          storedToken,
          storedTenantId,
          storedResidentId,
          storedName,
          storedResidentIdentity,
          storedResmanSession,
          storedDeviceSession,
          storedLocalUnlockEnabled,
        ] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY),
          SecureStore.getItemAsync(TENANT_ID_KEY),
          SecureStore.getItemAsync(RESIDENT_ID_KEY),
          SecureStore.getItemAsync(NAME_KEY),
          SecureStore.getItemAsync(RESIDENT_IDENTITY_KEY),
          getLargeSecureItemAsync(RESMAN_SESSION_KEY),
          getLargeSecureItemAsync(RESIDENT_DEVICE_SESSION_KEY),
          SecureStore.getItemAsync(LOCAL_UNLOCK_ENABLED_KEY),
        ]);
        const shouldUseLocalUnlock = storedLocalUnlockEnabled === "true";
        setLocalUnlockEnabled(shouldUseLocalUnlock);
        void refreshLocalUnlockAvailability().catch((error) => {
          console.warn("Failed to check Face ID availability.", error);
        });
        const parsedResidentIdentity = parseStoredResidentIdentity(storedResidentIdentity);
        if (
          storedToken &&
          storedTenantId &&
          storedResidentId &&
          storedName &&
          parsedResidentIdentity &&
          storedResmanSession &&
          storedDeviceSession
        ) {
          const parsedResmanSession = JSON.parse(storedResmanSession);
          const parsedDeviceSession = JSON.parse(storedDeviceSession);
          const heartbeatResult = await verifySession(storedToken, parsedResmanSession);
          rememberHeartbeatResult(heartbeatResult);
          if (shouldLogoutForHeartbeatResult(heartbeatResult)) {
            capture("session_expired", { via: "restore" });
            await performLogout();
            return;
          }

          setToken(storedToken);
          setTenantId(storedTenantId);
          setResidentId(storedResidentId);
          setName(storedName);
          setResident(parsedResidentIdentity);
          setResmanSession(parsedResmanSession);
          setDeviceSession(parsedDeviceSession);
          setIsAppLocked(shouldLockAppForLocalUnlock(shouldUseLocalUnlock, true));
        } else if (
          storedToken ||
          storedTenantId ||
          storedResidentId ||
          storedResidentIdentity ||
          storedResmanSession ||
          storedDeviceSession
        ) {
          await performLogout();
        }
      } catch (error) {
        console.warn("Failed to restore saved session.", error);
        await performLogout().catch((logoutError) => {
          console.warn("Failed to clear saved session after restore failure.", logoutError);
        });
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // ------------------------------------------------------------------
  // Emberly session verification
  // Re-checks with the API whenever the app returns to the foreground
  // after being away for at least MIN_BACKGROUND_MS.
  // ------------------------------------------------------------------
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "background" || state === "inactive") {
        lastBackgroundAt.current = Date.now();
        setIsAppLocked(
          (current) => current || shouldLockAppForLocalUnlock(localUnlockEnabled, Boolean(token)),
        );
        return;
      }

      if (state !== "active") return;

      const currentToken = token;
      const currentResmanSession = resmanSession;
      if (!currentToken || !currentResmanSession) return;

      const backgroundedFor = lastBackgroundAt.current
        ? Date.now() - lastBackgroundAt.current
        : Infinity;

      if (backgroundedFor < MIN_BACKGROUND_MS) return;
      if (!shouldRunHeartbeat(nextHeartbeatAfter.current)) return;

      // Fire-and-forget — don't block the UI
      void verifySession(currentToken, currentResmanSession)
        .then(async (result) => {
          rememberHeartbeatResult(result);
          if (shouldLogoutForHeartbeatResult(result)) {
            capture("session_expired", { via: "heartbeat" });
            await performLogout();
          }
        })
        .catch((error) => {
          console.warn("Session heartbeat failed.", error);
        });
    });

    return () => subscription.remove();
  }, [localUnlockEnabled, token, resmanSession]);

  useEffect(() => {
    if (!token || !resmanSession) return;

    const interval = setInterval(() => {
      if (!shouldRunHeartbeat(nextHeartbeatAfter.current)) return;

      void verifySession(token, resmanSession)
        .then(async (result) => {
          rememberHeartbeatResult(result);
          if (shouldLogoutForHeartbeatResult(result)) {
            capture("session_expired", { via: "heartbeat" });
            await performLogout();
          }
        })
        .catch((error) => {
          console.warn("Scheduled session heartbeat failed.", error);
        });
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [token, resmanSession]);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  async function persist(session: EmberlySession, resman: ResmanSession) {
    if (!session.deviceSession) {
      throw new Error("Resident device session is missing. Please sign in again.");
    }
    const residentIdentity: EmberlyResidentIdentity = {
      ...session.resident,
      unitId: normalizeUnitLabel(session.resident.unitId) || session.resident.unitId,
      unitNumber: normalizeUnitLabel(session.resident.unitNumber) || session.resident.unitNumber,
    };

    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, session.token),
      SecureStore.setItemAsync(TENANT_ID_KEY, residentIdentity.tenantId),
      SecureStore.setItemAsync(RESIDENT_ID_KEY, residentIdentity.residentId),
      SecureStore.setItemAsync(NAME_KEY, residentIdentity.name),
      SecureStore.setItemAsync(RESIDENT_IDENTITY_KEY, JSON.stringify(residentIdentity)),
      setLargeSecureItemAsync(RESMAN_SESSION_KEY, JSON.stringify(resman)),
      setLargeSecureItemAsync(RESIDENT_DEVICE_SESSION_KEY, JSON.stringify(session.deviceSession)),
    ]);
    setToken(session.token);
    setTenantId(residentIdentity.tenantId);
    setResidentId(residentIdentity.residentId);
    setName(residentIdentity.name);
    // Attribute subsequent events to this resident by stable id (no name/PII).
    identify(residentIdentity.residentId);
    setResident(residentIdentity);
    setDeviceSession(session.deviceSession ?? null);
    setResmanSession(resman);
    setIsAppLocked(false);
    setPendingSelection(null);
    pendingResmanSession.current = null;
    nextHeartbeatAfter.current = null;
  }

  async function performLogout() {
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(TENANT_ID_KEY),
      SecureStore.deleteItemAsync(RESIDENT_ID_KEY),
      SecureStore.deleteItemAsync(NAME_KEY),
      SecureStore.deleteItemAsync(RESIDENT_IDENTITY_KEY),
      deleteLargeSecureItemAsync(RESMAN_SESSION_KEY),
      deleteLargeSecureItemAsync(RESIDENT_DEVICE_SESSION_KEY),
      SecureStore.deleteItemAsync(LOCAL_UNLOCK_ENABLED_KEY),
    ]);
    setToken(null);
    setTenantId(null);
    setResidentId(null);
    setName(null);
    setResident(null);
    setDeviceSession(null);
    setResmanSession(null);
    setLocalUnlockEnabled(false);
    setIsAppLocked(false);
    setPendingSelection(null);
    pendingResmanSession.current = null;
    nextHeartbeatAfter.current = null;
    // Clear the analytics identity so later events aren't tied to this resident.
    resetAnalytics();
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  async function login(username: string, password: string): Promise<LoginResult> {
    const result = await loginResident(username, password);

    if (!result.requiresSelection) {
      await persist(result.emberlySession, result.resmanSession);
      return { requiresSelection: false };
    }

    pendingResmanSession.current = result.resmanSession;
    setPendingSelection({
      selectionToken: result.selectionToken,
      residents: result.residents,
    });

    return {
      requiresSelection: true,
      residents: result.residents,
    };
  }

  async function completeSelection(selectionToken: string, residentId: string) {
    const resman = pendingResmanSession.current;
    if (!resman) {
      throw new Error("ResMan session is missing. Please sign in again.");
    }

    const result = await selectResident(selectionToken, residentId);
    await persist(result.emberlySession, resman);
  }

  async function enableLocalUnlock() {
    const unlocked = await authenticateWithLocalUnlock("Enable Face ID for Emberly Apartments");
    if (!unlocked) return;

    await SecureStore.setItemAsync(LOCAL_UNLOCK_ENABLED_KEY, "true");
    setLocalUnlockEnabled(true);
    setIsAppLocked(false);
  }

  async function disableLocalUnlock() {
    await SecureStore.setItemAsync(LOCAL_UNLOCK_ENABLED_KEY, "false");
    setLocalUnlockEnabled(false);
    setIsAppLocked(false);
  }

  async function unlockWithLocalAuth() {
    try {
      const unlocked = await authenticateWithLocalUnlock(`Unlock with ${localUnlockStatus.label}`);
      // `false` here is a user cancel; hard failures throw and land below.
      capture("local_unlock_used", { success: unlocked });
      if (unlocked) setIsAppLocked(false);
      return unlocked;
    } catch (error) {
      capture("local_unlock_used", { success: false, reason: "error" });
      throw error;
    }
  }

  async function logout() {
    await performLogout();
  }

  return (
    <AuthContext.Provider
      value={{
        token,
        tenantId,
        residentId,
        resident,
        name,
        deviceSession,
        resmanSession,
        pendingSelection,
        isLoading,
        isAppLocked,
        isLocalUnlocking,
        localUnlockEnabled,
        localUnlockAvailable: localUnlockStatus.available,
        localUnlockLabel: localUnlockStatus.label,
        localUnlockUnavailableReason: localUnlockStatus.unavailableReason,
        login,
        completeSelection,
        enableLocalUnlock,
        disableLocalUnlock,
        unlockWithLocalAuth,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

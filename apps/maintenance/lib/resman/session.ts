import CookieManager from "@react-native-cookies/cookies";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { PRODUCTION_ORIGIN } from "@emberly/core";
import type { ResmanSessionCookie } from "@/lib/api/auth";
import {
  MULTI_SOUTH_STAFF_PORTAL,
  buildStaffCredentialBody,
  extractResManVerificationToken,
  isResManLoginRedirectUrl,
  oidcFormPostLooksValid,
  parseOidcFormPostPage,
  resManFormURLEncode,
} from "@emberly/core";
import { capture } from "@/lib/analytics";

/**
 * The technician's own ResMan session, held ONLY on this device.
 *
 * Sign-in already collects the tech's ResMan username/password (they are
 * validated through the Emberly API and exchanged for the staff token; the
 * password is never stored). This module reuses that same moment to run the
 * ResMan staff OIDC dance FROM THE DEVICE, so the resulting session cookies
 * land in the phone's native cookie store — never on any server. Work-order
 * writes then go straight to ResMan under this session, which means ResMan's
 * own audit history records the technician, not a service account.
 *
 * React Native's fetch makes this simpler than the sync worker's node client:
 * the native HTTP stack persists Set-Cookie on every hop of an auto-followed
 * redirect chain, so no manual redirect walking and no cookie jar of our own.
 * What we keep is the pure protocol logic from @emberly/core: the CSRF token
 * harvest, the credential body, and the auto-submitting form_post replay
 * (which fetch does NOT follow — it is an HTML form, not an HTTP redirect).
 *
 * CREDENTIALS: the technician's ResMan username AND password persist in the
 * device Keychain (WHEN_UNLOCKED_THIS_DEVICE_ONLY — never synced, wiped on
 * sign-out or on a rejected renewal). Owner-approved change from the original
 * "password never stored" posture: ResMan idle-times sessions out, iOS won't
 * let a backgrounded app keep them alive, and without stored credentials
 * every timeout dumped the tech at "Sign in again to sync changes". With
 * them, an expired session silently renews and the sign-in screen appears
 * only when the credentials themselves stop working.
 */

const PORTAL = MULTI_SOUTH_STAFF_PORTAL;
const SESSION_KEY = "emberly_resman_session";

/** Same resolution as the config store's BASE_URL, duplicated on purpose —
 *  importing the config store would drag its native deps into this module. */
const SERVER_BASE_URL = process.env.EXPO_PUBLIC_BASE_URL || PRODUCTION_ORIGIN;

/**
 * The same Safari UA the sync worker's proven node client sends. The app's
 * default UA is CFNetwork/…, which web-facing infrastructure treats
 * differently from a browser — and this whole module is impersonating the
 * browser flow ResMan actually serves.
 */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const HTML_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "user-agent": BROWSER_UA,
} as const;

/** Per-request deadline on the login steps — a stuck step must surface as
 *  "unreachable" on the sign-in screen, never as a spinner that sits forever. */
const LOGIN_STEP_TIMEOUT_MS = 20_000;

const PROBE_TIMEOUT_MS = 10_000;
const SIGN_OUT_TIMEOUT_MS = 8_000;

/** Run a fetch with a hard deadline — iOS's own 60s timeout is far too long
 *  for anything sitting in front of a button. */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** How the tech signs out of ResMan (from MainMenu.js's #SignOut handler). */
const SIGN_OUT_PATH = "/Access/SignOut";

export type ResManSessionStatus =
  /** Never established on this device (or explicitly signed out). */
  | "absent"
  /** A persisted session exists but no probe has answered since launch — the
   *  cookies may well be alive. Renders as "checking", and must NEVER kick to
   *  sign-in: every cold start passes through here. */
  | "unverified"
  /** Established; last check saw an authenticated session. */
  | "active"
  /** A request hit the login redirect — the tech must sign in again. */
  | "expired";

export type EstablishResult =
  { ok: true } | { ok: false; reason: "invalid" | "unreachable" | "already_authenticated" };

/** Pull the (already-encoded) ReturnUrl off the login page URL without the
 *  URL API — React Native's URL support is not something to lean on. */
export function returnUrlFromLoginUrl(loginUrl: string): string {
  const match = /[?&]ReturnUrl=([^&#]+)/.exec(loginUrl);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const consumerBase = PORTAL.consumerStartUrl.replace(/\/$/, "");

type FetchLike = typeof fetch;

/**
 * The 3-step staff login over an auto-following, cookie-persisting fetch.
 * Pure protocol — injected fetch so tests can script it.
 */
export async function performDeviceLogin(
  username: string,
  password: string,
  fetchImpl: FetchLike = fetch,
): Promise<EstablishResult> {
  try {
    // 1. Bootstrap: the consumer root redirects (auto-followed) to the auth
    // login page, whose URL carries the OIDC ReturnUrl and whose HTML carries
    // the CSRF token. An already-live session lands on the consumer root
    // instead — callers sign out first when switching users.
    const bootstrap = await withTimeout(
      (signal) =>
        fetchImpl(PORTAL.consumerStartUrl, {
          credentials: "include",
          headers: HTML_HEADERS,
          signal,
        }),
      LOGIN_STEP_TIMEOUT_MS,
    );
    const loginUrl = bootstrap.url || PORTAL.consumerStartUrl;
    const bootstrapHtml = await bootstrap.text();
    if (!isResManLoginRedirectUrl(loginUrl)) {
      // Already authenticated as SOMEONE — ResMan's sign-out had not
      // propagated before this bootstrap. establish() handles the retry;
      // never silently adopt an unknown identity here.
      return { ok: false, reason: "already_authenticated" };
    }
    const token = extractResManVerificationToken(bootstrapHtml);
    if (!token) return { ok: false, reason: "unreachable" };

    // 2. POST the credentials. Success is the auto-submitting OIDC form_post
    // page; failure re-renders the login form (no absolute form action).
    const credentialResponse = await withTimeout(
      (signal) =>
        fetchImpl(loginUrl, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded", ...HTML_HEADERS },
          body: buildStaffCredentialBody({
            portal: PORTAL,
            returnUrl: returnUrlFromLoginUrl(loginUrl),
            username,
            password,
            token,
          }),
          signal,
        }),
      LOGIN_STEP_TIMEOUT_MS,
    );
    const formPost = parseOidcFormPostPage(await credentialResponse.text());
    if (!oidcFormPostLooksValid(formPost)) {
      return { ok: false, reason: "invalid" };
    }

    // 3. Replay the form_post to signin-oidc — fetch cannot auto-submit an
    // HTML form, so this POST is built by hand; the redirect chain that
    // follows it IS auto-followed, landing on the consumer root with the
    // session cookies already persisted by the native stack.
    const oidc = await withTimeout(
      (signal) =>
        fetchImpl(formPost.action, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded", ...HTML_HEADERS },
          body: resManFormURLEncode(formPost.fields),
          signal,
        }),
      LOGIN_STEP_TIMEOUT_MS,
    );
    if (isResManLoginRedirectUrl(oidc.url || "")) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * One cheap probe of the consumer root, in three honest states: "active"
 * (served), "expired" (bounced to the login page — genuinely dead),
 * "unreachable" (network failure/timeout — the session state is UNKNOWN, and
 * treating that as expired would kick an offline technician to a login screen
 * they cannot use). Bounded — a probe must never stall a write. A successful
 * probe also refreshes ResMan's sliding session expiry — the keep-alive rides
 * on that.
 */
export type ProbeResult = "active" | "expired" | "unreachable";

export async function probeSession(fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(PORTAL.consumerStartUrl, {
          credentials: "include",
          headers: HTML_HEADERS,
          signal,
        }),
      PROBE_TIMEOUT_MS,
    );
    await response.text(); // drain
    return isResManLoginRedirectUrl(response.url || "") ? "expired" : "active";
  } catch {
    return "unreachable";
  }
}

/**
 * Best-effort server-side sign-out (GET /Access/SignOut), bounded. Never
 * throws: an offline or slow sign-out is still a local sign-out — the server
 * session simply ages out.
 */
export async function remoteSignOut(
  fetchImpl: FetchLike = fetch,
  timeoutMs = SIGN_OUT_TIMEOUT_MS,
): Promise<void> {
  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(`${consumerBase}${SIGN_OUT_PATH}`, {
          credentials: "include",
          headers: HTML_HEADERS,
          signal,
        }),
      timeoutMs,
    );
    await response.text(); // drain
  } catch {
    /* offline or slow — the local sign-out stands */
  }
}

interface PersistedSession {
  username: string;
  establishedAt: number;
}

function parsePersisted(raw: string | null): PersistedSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof value.username === "string" && typeof value.establishedAt === "number") {
      return { username: value.username, establishedAt: value.establishedAt };
    }
  } catch {
    /* corrupted — treat as absent */
  }
  return null;
}

const CREDENTIALS_KEY = "emberly_resman_credentials";
/** Strictest non-biometric class: never leaves this device, never in iCloud
 *  Keychain, unreadable while locked (renewals only run with the app
 *  foregrounded, so locked-state access is never needed). */
const CREDENTIAL_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

interface StoredCredentials {
  username: string;
  password: string;
}

function parseCredentials(raw: string | null): StoredCredentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredCredentials>;
    if (typeof value.username === "string" && typeof value.password === "string") {
      return { username: value.username, password: value.password };
    }
  } catch {
    /* corrupted — treat as absent */
  }
  return null;
}

async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    return parseCredentials(
      await SecureStore.getItemAsync(CREDENTIALS_KEY, CREDENTIAL_STORE_OPTIONS),
    );
  } catch {
    // A locked keychain (or a class migration) reads as no credentials — the
    // renewal just doesn't happen this tick.
    return null;
  }
}

async function wipeCredentials(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CREDENTIALS_KEY, CREDENTIAL_STORE_OPTIONS);
  } catch {
    /* nothing to wipe */
  }
}

/**
 * File server-established ResMan cookies into the NATIVE cookie store — the
 * same store the app's fetches ride on. The server performs the login (its
 * egress IP is long-trusted by ResMan; a first-time device login trips the
 * portal's new-device challenge) and hands the session over; from here it
 * lives only on this device.
 */
export async function injectServerCookies(cookies: readonly ResmanSessionCookie[]): Promise<void> {
  for (const cookie of cookies) {
    await CookieManager.set(`https://${cookie.domain}${cookie.path || "/"}`, {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      secure: true,
      httpOnly: true,
      ...(cookie.expires ? { expires: cookie.expires } : {}),
    });
  }
}

type ServerSessionResult =
  { ok: true; cookies: ResmanSessionCookie[] } | { ok: false; reason: "invalid" | "unreachable" };

/**
 * Ask emberly-web to run the ResMan login and hand back the session cookies
 * (POST /api/admin/auth/resman-session). Bounded like every other network
 * call that can sit in front of the UI.
 */
export async function fetchServerSession(
  username: string,
  password: string,
  fetchImpl: FetchLike = fetch,
): Promise<ServerSessionResult> {
  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(`${SERVER_BASE_URL}/api/admin/auth/resman-session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
          signal,
        }),
      LOGIN_STEP_TIMEOUT_MS,
    );
    if (response.status === 401) return { ok: false, reason: "invalid" };
    if (response.status !== 200) return { ok: false, reason: "unreachable" };
    const payload = (await response.json()) as { cookies?: unknown };
    const cookies = Array.isArray(payload.cookies)
      ? (payload.cookies as ResmanSessionCookie[])
      : [];
    if (cookies.length === 0) return { ok: false, reason: "unreachable" };
    return { ok: true, cookies };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

interface ResManSessionState {
  status: ResManSessionStatus;
  /** ResMan username the session belongs to ("" when absent). */
  username: string;
  /** Keychain credentials exist — an expired session will renew itself, so
   *  nothing should kick to sign-in while this is true. */
  canRenew: boolean;
  /** Epoch ms of the last establish attempt — the expiry kick stays quiet for
   *  a grace window after it so a failing establish can never bounce a tech
   *  straight back to the sign-in screen they just left. */
  lastEstablishAt: number | null;
  /** Why the last establish failed (null after a success) — shown in Settings
   *  so a broken sign-in names itself instead of looping silently. */
  lastEstablishReason: "invalid" | "unreachable" | "already_authenticated" | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Establish this technician's session. `serverCookies` (from the sign-in
   *  response, where the server already ran the ResMan login) are injected
   *  directly; otherwise the server session endpoint is asked, and the
   *  on-device dance remains the last resort. */
  establish: (
    username: string,
    password: string,
    serverCookies?: readonly ResmanSessionCookie[],
  ) => Promise<EstablishResult>;
  /** Re-check the session against ResMan; flips status accordingly.
   *  `fetchImpl` is injectable so the write path (and tests) can thread their
   *  own transport through. */
  verify: (fetchImpl?: FetchLike) => Promise<boolean>;
  /** Throttled keep-alive: while active, ping ResMan every few minutes so the
   *  sliding session expiry keeps sliding through a workday. Rides the sync
   *  tick; a tick inside the throttle window costs nothing. */
  keepAlive: () => Promise<void>;
  /** Called by the write path when a request hit the login redirect. */
  markExpired: () => void;
  /** Silent re-login with the Keychain credentials. Single-flight; wipes the
   *  credentials (and stays expired → sign-in) when ResMan rejects them. */
  renew: (fetchImpl?: FetchLike) => Promise<boolean>;
  /** GET /Access/SignOut and forget the session. */
  signOut: () => Promise<void>;
}

/** Keep-alive throttle — module-scoped, one clock for the one store. */
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
let lastKeepAliveAt = 0;

/** Single-flight guard so a burst of expired writes renews ONCE. */
let renewInFlight: Promise<boolean> | null = null;

export const useResManSession = create<ResManSessionState>((set, get) => ({
  status: "absent",
  username: "",
  canRenew: false,
  lastEstablishAt: null,
  lastEstablishReason: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const persisted = parsePersisted(await SecureStore.getItemAsync(SESSION_KEY));
    const credentials = await readCredentials();
    set({
      hydrated: true,
      username: persisted?.username ?? "",
      canRenew: credentials !== null,
      // The cookies may or may not still be alive — "unverified" is honest
      // without kicking anyone anywhere; the probe below settles it.
      status: persisted ? "unverified" : "absent",
    });
    // Cheap background probe EVEN with nothing persisted: the native cookies
    // can outlive our marker (a failed establish deletes the marker first),
    // and a live session must read as Active, not "sign in again".
    void get().verify();
  },

  establish: async (username, password, serverCookies) => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    set({ status: "absent", username: "", lastEstablishAt: Date.now() });
    // Clear whatever session lingers, local cookie store included — the next
    // session must be THIS technician's, never an inherited one.
    await remoteSignOut();
    try {
      await CookieManager.clearAll();
    } catch {
      /* nothing to clear */
    }

    // Preferred path: a session the SERVER established (its IP is trusted by
    // ResMan; the device's own first login trips the new-device challenge).
    // Sign-in hands cookies straight in; renewal asks the endpoint.
    let result: EstablishResult | null = null;
    let cookies: readonly ResmanSessionCookie[] | null = serverCookies ?? null;
    if (!cookies) {
      const server = await fetchServerSession(username, password);
      if (server.ok) cookies = server.cookies;
      else if (server.reason === "invalid") result = { ok: false, reason: "invalid" };
    }
    if (!result && cookies) {
      await injectServerCookies(cookies);
      result =
        (await probeSession()) === "active" ? { ok: true } : { ok: false, reason: "unreachable" };
    }

    // Last resort: the on-device dance (works on some networks; kept for
    // resilience when the server is unreachable).
    if (!result || (!result.ok && result.reason === "unreachable")) {
      let device = await performDeviceLogin(username, password);
      if (!device.ok && device.reason === "already_authenticated") {
        await remoteSignOut();
        device = await performDeviceLogin(username, password);
        if (!device.ok && device.reason === "already_authenticated") {
          device = { ok: false, reason: "unreachable" };
        }
      }
      if (device.ok || !result) result = device;
    }
    if (result.ok) {
      set({ status: "active", username, canRenew: true, lastEstablishReason: null });
      await SecureStore.setItemAsync(
        SESSION_KEY,
        JSON.stringify({ username, establishedAt: Date.now() } satisfies PersistedSession),
      );
      // The proven-good credentials go to the Keychain (device-only class) so
      // an idle-timed-out session renews silently instead of surfacing
      // "Sign in again" — see the module header for the posture change.
      await SecureStore.setItemAsync(
        CREDENTIALS_KEY,
        JSON.stringify({ username, password } satisfies StoredCredentials),
        CREDENTIAL_STORE_OPTIONS,
      );
      capture("resman_session_established", {});
    } else {
      if (result.reason === "invalid") {
        // Rejected: whatever the Keychain holds is not known-good — wipe
        // rather than renew with it. Transport failures keep any existing
        // credentials; they may be fine.
        await wipeCredentials();
        set({ canRenew: false });
      }
      set({ status: "absent", username: "", lastEstablishReason: result.reason });
      capture("resman_session_establish_failed", { reason: result.reason });
      // Deliberately NOT verify() here. A failed establish leaves no claimed
      // owner, and verify() renews from the Keychain — which after a failed
      // Switch User still holds the PREVIOUS technician's credentials, so the
      // probe would quietly sign the device back in as them (field-verified).
      // The settings row reads the failure reason instead, which is the honest
      // answer, and the next tick's keepAlive re-probes once an owner exists.
    }
    return result;
  },

  verify: async (fetchImpl = fetch) => {
    const probe = await probeSession(fetchImpl);
    const { status } = get();
    if (probe === "active" && status !== "active") set({ status: "active" });
    if (probe === "expired") {
      // A genuine bounce — but with Keychain credentials this is a renewal,
      // not a sign-out: the tech only sees the sign-in screen when ResMan
      // rejects the stored credentials themselves.
      if (await get().renew(fetchImpl)) return true;
      get().markExpired();
    }
    // "unreachable" changes nothing: the session may be fine, the network is not.
    return probe === "active";
  },

  renew: async (fetchImpl = fetch) => {
    if (renewInFlight) return renewInFlight;
    renewInFlight = (async () => {
      // WHOSE session may this renewal produce? The app's signed-in technician
      // and nobody else. Sampling that here would be a TOCTOU read — the login
      // legs below take up to 60s — so the owner is re-checked at the moment
      // of the state transition, which is the only place it is atomic.
      const credentials = await readCredentials();
      if (!credentials) {
        set({ canRenew: false });
        return false;
      }
      let result: EstablishResult;
      const server = await fetchServerSession(
        credentials.username,
        credentials.password,
        fetchImpl,
      );
      if (server.ok) {
        await injectServerCookies(server.cookies);
        result =
          (await probeSession(fetchImpl)) === "active"
            ? { ok: true }
            : { ok: false, reason: "unreachable" };
      } else if (server.reason === "invalid") {
        result = { ok: false, reason: "invalid" };
      } else {
        // Server unreachable — the on-device dance is better than nothing.
        result = await performDeviceLogin(credentials.username, credentials.password, fetchImpl);
      }
      if (result.ok) {
        let adopted = false;
        set((state) => {
          // The identity may have changed while the login was in flight (a
          // Switch User landed, or a sign-out). Publishing here would hand the
          // device a session belonging to the PREVIOUS technician while the app
          // is signed in as someone else — ResMan's audit history would then
          // credit the wrong person, which is the one thing this architecture
          // exists to prevent. "" means no owner is claimed yet, so the
          // renewal may take it.
          if (state.username !== "" && state.username !== credentials.username) return state;
          adopted = true;
          return { status: "active", username: credentials.username, canRenew: true };
        });
        if (!adopted) {
          // Someone else owns the app now. The cookies this login just planted
          // are not theirs, so drop them rather than leave a foreign session
          // sitting in the jar for the next write to use.
          await remoteSignOut(fetchImpl);
          capture("resman_session_renew_discarded", {});
          return false;
        }
        capture("resman_session_renewed", {});
        return true;
      }
      if (result.reason === "invalid") {
        // Password changed or account disabled — these credentials are dead.
        // Wiping flips canRenew so the expiry kick finally sends the tech to
        // sign-in, which is now genuinely the only fix.
        await wipeCredentials();
        set({ canRenew: false });
        capture("resman_session_renew_rejected", {});
      }
      // "unreachable" keeps the credentials; the next tick tries again.
      return false;
    })();
    try {
      return await renewInFlight;
    } finally {
      renewInFlight = null;
    }
  },

  keepAlive: async () => {
    const { status } = get();
    if (status !== "active" && status !== "unverified") return;
    const now = Date.now();
    if (now - lastKeepAliveAt < KEEP_ALIVE_INTERVAL_MS) return;
    lastKeepAliveAt = now;
    await get().verify();
  },

  markExpired: () => {
    if (get().status !== "expired") {
      set({ status: "expired" });
      capture("resman_session_expired", {});
    }
  },

  signOut: async () => {
    // Local first, and INSTANT — this sits behind the Sign out button, and an
    // unbounded network await here once made that button look dead for up to
    // 60 seconds. The server-side sign-out fires in the background, bounded.
    // The Keychain credentials go with the session: sign-out means THIS tech
    // is done on this device, and the next one must never inherit a renewal.
    await SecureStore.deleteItemAsync(SESSION_KEY);
    await wipeCredentials();
    set({ status: "absent", username: "", canRenew: false });
    void remoteSignOut();
  },
}));

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
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
 * Only the username and a timestamp are persisted (Keychain-backed), so the
 * re-auth prompt can say who is signing back in. Session validity is a live
 * question, answered by whether ResMan redirects us to its login page.
 */

const PORTAL = MULTI_SOUTH_STAFF_PORTAL;
const SESSION_KEY = "emberly_resman_session";

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

export type EstablishResult = { ok: true } | { ok: false; reason: "invalid" | "unreachable" };

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
      // Already authenticated as SOMEONE. Treat as success only if the caller
      // knowingly kept the session; establish() signs out first, so reaching
      // here means the sign-out failed — report unreachable rather than
      // silently keeping an unknown identity.
      return { ok: false, reason: "unreachable" };
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

interface ResManSessionState {
  status: ResManSessionStatus;
  /** ResMan username the session belongs to ("" when absent). */
  username: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Sign out any lingering session, then log in as this technician. */
  establish: (username: string, password: string) => Promise<EstablishResult>;
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
  /** GET /Access/SignOut and forget the session. */
  signOut: () => Promise<void>;
}

/** Keep-alive throttle — module-scoped, one clock for the one store. */
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
let lastKeepAliveAt = 0;

export const useResManSession = create<ResManSessionState>((set, get) => ({
  status: "absent",
  username: "",
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const persisted = parsePersisted(await SecureStore.getItemAsync(SESSION_KEY));
    set({
      hydrated: true,
      username: persisted?.username ?? "",
      // The cookies may or may not still be alive — "unverified" is honest
      // without kicking anyone anywhere; the probe below settles it.
      status: persisted ? "unverified" : "absent",
    });
    if (persisted) {
      // Cheap background probe; native cookies often outlive an app restart.
      void get().verify();
    }
  },

  establish: async (username, password) => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    set({ status: "absent", username: "" });
    // Unlike the button path, login MUST wait for the server-side sign-out
    // (bounded): a lingering predecessor session would make the bootstrap
    // land authenticated and the login refuse.
    await remoteSignOut();
    const result = await performDeviceLogin(username, password);
    if (result.ok) {
      set({ status: "active", username });
      await SecureStore.setItemAsync(
        SESSION_KEY,
        JSON.stringify({ username, establishedAt: Date.now() } satisfies PersistedSession),
      );
      capture("resman_session_established", {});
    } else {
      set({ status: "absent" });
      capture("resman_session_establish_failed", { reason: result.reason });
    }
    return result;
  },

  verify: async (fetchImpl = fetch) => {
    const probe = await probeSession(fetchImpl);
    const { status } = get();
    if (probe === "active" && status !== "active") set({ status: "active" });
    if (probe === "expired") get().markExpired();
    // "unreachable" changes nothing: the session may be fine, the network is not.
    return probe === "active";
  },

  keepAlive: async () => {
    if (get().status !== "active") return;
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
    await SecureStore.deleteItemAsync(SESSION_KEY);
    set({ status: "absent", username: "" });
    void remoteSignOut();
  },
}));

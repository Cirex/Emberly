/**
 * ResMan admin (staff) credential validation for the web app.
 *
 * Runs the same OIDC login the sync worker uses — bootstrap (GET consumer root →
 * follow to the login page → read the CSRF token), POST the credentials, then
 * replay the auto-submitting `form_post` to `signin-oidc` — with a self-contained
 * cookie jar + manual redirect following. Validate-only: it confirms the
 * username/password authenticate against the ResMan **staff** portal and returns
 * success/failure; it does not persist a session. Ported from
 * supabase/sync/src/resman/client.ts (login flow) + cookies.ts.
 *
 * This is distinct from lib/resman-portal.ts, which logs into the separate
 * ResMan **resident** portal for resident access checks.
 */

import {
  decodeHtmlEntities,
  extractRequestVerificationToken,
  getSetCookieHeaders,
  hiddenInputValue,
} from "./resman-html";

const MAX_REDIRECTS = 12;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export interface ResmanAdminConfig {
  consumerStartUrl: string;
  authBaseUrl: string;
  accountId: string;
  companyName: string;
}

/**
 * The staff identity ResMan embeds in the authenticated app page (hidden inputs
 * + a `window.personID` JS var): the stable person GUID, the full display name,
 * and the login short name. Any field may be null if the markup shifts.
 */
export interface ResmanLoggedInIdentity {
  /** LoggedInPersonID / window.personID — the stable per-person GUID. */
  personId: string | null;
  /** LoggedInPersonName — the full display name, e.g. "Ben Bloch". */
  personName: string | null;
  /** LoggedInUser — the login short name, e.g. "bbloch". */
  shortName: string | null;
}

export type ResmanAdminLoginResult =
  | { ok: true; username: string; identity: ResmanLoggedInIdentity }
  | { ok: false; reason: "invalid_credentials" | "unavailable"; detail?: string };

/** Resolve the ResMan staff-portal config from env (defaults to Multi-South). */
export function resolveResmanAdminConfig(): ResmanAdminConfig {
  const subdomain = process.env.RESMAN_SUBDOMAIN?.trim() || "multisouth";
  const accountId = process.env.RESMAN_ACCOUNT_ID?.trim() || "1659";
  return {
    consumerStartUrl: `https://${subdomain}.myresman.com/`,
    authBaseUrl: `https://${subdomain}.auth.myresman.com`,
    accountId,
    companyName: process.env.RESMAN_COMPANY_NAME?.trim() || "The Multi-South Group",
  };
}

// ---- pure helpers (ported) --------------------------------------------------

const UNRESERVED = /[A-Za-z0-9\-._~]/;

function percentEncode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && UNRESERVED.test(ch)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function formURLEncode(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&");
}

/** Read an inline JS assignment like `window.personID = "GUID"` / `personID: 'GUID'`. */
function jsAssignedValue(html: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*[:=]\\s*["']([^"']+)["']`, "i").exec(html);
  return match ? match[1] : null;
}

/**
 * Pull the signed-in staff identity out of an authenticated ResMan app page.
 * The GUID falls back to the `window.personID` JS var when the hidden input is
 * absent; the display name is HTML-entity decoded ("Ben&#39;s" → "Ben's").
 */
export function extractLoggedInIdentity(html: string): ResmanLoggedInIdentity {
  const personName = hiddenInputValue(html, "LoggedInPersonName");
  const shortName = hiddenInputValue(html, "LoggedInUser");
  const personId = hiddenInputValue(html, "LoggedInPersonID") ?? jsAssignedValue(html, "personID");
  return {
    personId: personId?.trim() || null,
    personName: personName ? decodeHtmlEntities(personName).trim() || null : null,
    shortName: shortName?.trim() || null,
  };
}

/** Prefer the primary page's fields, backfilling any gaps from a fallback page. */
function mergeIdentity(
  primary: ResmanLoggedInIdentity,
  fallback: ResmanLoggedInIdentity,
): ResmanLoggedInIdentity {
  return {
    personId: primary.personId ?? fallback.personId,
    personName: primary.personName ?? fallback.personName,
    shortName: primary.shortName ?? fallback.shortName,
  };
}

function parseOidcFormPost(
  html: string,
): { action: string; fields: Array<[string, string]> } | null {
  const actionMatch = /action=["']([^"']+)["']/.exec(html);
  if (!actionMatch) return null;
  const action = decodeHtmlEntities(actionMatch[1]);
  const fields: Array<[string, string]> = [];
  const inputRegex = /<input[^>]*\bname=['"]([^'"]+)['"][^>]*\bvalue=['"]([^'"]*)['"]/gi;
  for (const match of html.matchAll(inputRegex)) fields.push([match[1], match[2]]);
  return { action, fields };
}

// ---- minimal cookie jar (keyed by name, single-host) ------------------------

interface JarCookie {
  value: string;
  expires: number | null;
  /** Host of the response that set it — what a device needs to file the
   *  cookie under the right domain when a session is handed over. */
  domain: string;
  path: string;
}

/** One session cookie in the shape the native apps inject into their cookie
 *  store when the server performs the ResMan login on their behalf. */
export interface ResmanSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** ISO expiry, or null for a session cookie. */
  expires: string | null;
}

/**
 * Keyed by cookie NAME alone, deliberately.
 *
 * The staff login spans two hosts, so name-only keying looks like a bug: a
 * same-named cookie from the second host would silently overwrite the first.
 * It was reported as one, and twice rewritten to key by name+domain+path —
 * both attempts introduced worse regressions than the defect they chased (a
 * clearing Set-Cookie that no longer clears; two cookies of one name emitted
 * in a Cookie header with no RFC 6265 s5.4 ordering), because correct scoping
 * means implementing domain-match, path-match and shadowing properly.
 *
 * So the premise was measured against the live portal (2026-08-28), by running
 * the real login and recording every Set-Cookie by host:
 *
 *   multisouth.myresman.com       .AspNet.Cookies, ASP.NET_SessionId, AccountID,
 *                                 CompanyName, LoginTrackingID, ManagementPersonID,
 *                                 OpenIdConnect.nonce.*, RoleInstance, Subdomain,
 *                                 __RequestVerificationToken
 *   multisouth.auth.myresman.com  .AspNetCore.Antiforgery.*, ARRAffinity(SameSite),
 *                                 AccountId, idsrv (x2), idsrv.external, idsrv.session
 *
 * NO name is set by both hosts — note AccountID and AccountId differ only in
 * case, and each host sets exactly one of them. The only true collision is
 * same-host: idsrv is set at both path=/ and path=/auth, where last-writer-wins
 * has always been the behaviour and the login has always worked.
 *
 * Re-open this only with evidence that ResMan's cookie names have changed;
 * re-run that measurement before rewriting anything.
 */
class CookieJar {
  private readonly cookies = new Map<string, JarCookie>();

  ingest(headers: Headers, host = ""): void {
    for (const header of getSetCookieHeaders(headers)) {
      const [pair, ...rawAttrs] = header.split(";").map((p) => p.trim());
      const sep = pair.indexOf("=");
      if (sep < 0) continue;
      const name = pair.slice(0, sep);
      const value = pair.slice(sep + 1);
      let expires: number | null = null;
      let domain = host;
      let path = "/";
      for (const attr of rawAttrs) {
        const eq = attr.indexOf("=");
        const key = (eq < 0 ? attr : attr.slice(0, eq)).toLowerCase();
        const val = eq < 0 ? "" : attr.slice(eq + 1);
        if (key === "max-age") {
          const s = Number.parseInt(val, 10);
          if (Number.isFinite(s)) expires = Date.now() + s * 1000;
        } else if (key === "expires") {
          const p = Date.parse(val);
          if (Number.isFinite(p)) expires = p;
        } else if (key === "domain" && val) {
          domain = val.replace(/^\./, "");
        } else if (key === "path" && val) {
          path = val;
        }
      }
      this.cookies.set(name, { value, expires, domain, path });
    }
  }

  /** Unexpired cookies for handing a freshly-established session to a device. */
  serialize(now = Date.now()): ResmanSessionCookie[] {
    return Array.from(this.cookies.entries())
      .filter(([, c]) => c.expires === null || c.expires > now)
      .map(([name, c]) => ({
        name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires === null ? null : new Date(c.expires).toISOString(),
      }));
  }

  header(now = Date.now()): string {
    return Array.from(this.cookies.entries())
      .filter(([, c]) => c.expires === null || c.expires > now)
      .map(([name, c]) => `${name}=${c.value}`)
      .join("; ");
  }
}

interface FetchResult {
  status: number;
  finalUrl: string;
  text: string;
}

async function fetchFollowing(
  jar: CookieJar,
  start: { url: string; method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
): Promise<FetchResult> {
  let url = start.url;
  let method = start.method;
  let body = start.body;
  const baseHeaders = start.headers ?? {};

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      ...baseHeaders,
    };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (body === undefined) delete headers["content-type"];

    const response = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "manual",
    });
    jar.ingest(response.headers, new URL(url).hostname);

    const status = response.status;
    const location = response.headers.get("location");
    if (status >= 300 && status < 400 && location && hop < MAX_REDIRECTS) {
      url = new URL(location, url).toString();
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    const text = await response.text();
    return { status, finalUrl: response.url || url, text };
  }
  throw new Error(`Exceeded ${MAX_REDIRECTS} redirects`);
}

/** Challenge keywords that distinguish a device/MFA/CAPTCHA page from a plain
 *  "wrong password" login re-render. Matched case-insensitively against the HTML. */
const CHALLENGE_MARKERS = [
  "verify",
  "verification",
  "device",
  "authenticator",
  "one-time",
  "passcode",
  "captcha",
  "locked",
  "mfa",
  "two-factor",
] as const;

function pageTitle(html: string): string | null {
  return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim().slice(0, 120) ?? null;
}

/** One step of the login flow, summarized to non-sensitive shape (plus the raw
 *  HTML only when `captureHtml` is set — used by the offline debug harness). */
export interface ResmanLoginStepTrace {
  name: "bootstrap" | "post-credentials" | "oidc-replay";
  status: number;
  finalUrl: string;
  title: string | null;
  htmlLength: number;
  /** Which CHALLENGE_MARKERS appear — non-empty strongly implies a device/MFA
   *  challenge page rather than a wrong-password re-render. */
  challengeMarkers: string[];
  csrfTokenFound?: boolean;
  formPostAction?: string | null;
  formPostFields?: number;
  /** Raw response HTML — present only when traced with `captureHtml: true`. */
  html?: string;
}

export interface ResmanLoginTrace {
  steps: ResmanLoginStepTrace[];
  result: ResmanAdminLoginResult;
}

function summarizeStep(
  name: ResmanLoginStepTrace["name"],
  resp: FetchResult,
  extra: Partial<ResmanLoginStepTrace>,
  captureHtml: boolean,
): ResmanLoginStepTrace {
  const haystack = resp.text.toLowerCase();
  return {
    name,
    status: resp.status,
    finalUrl: resp.finalUrl,
    title: pageTitle(resp.text),
    htmlLength: resp.text.length,
    challengeMarkers: CHALLENGE_MARKERS.filter((m) => haystack.includes(m)),
    ...extra,
    ...(captureHtml ? { html: resp.text } : {}),
  };
}

/**
 * Run the full ResMan staff OIDC login and return BOTH the pass/fail result and
 * a per-step trace. This is the single source of truth for the login flow;
 * `validateResmanAdminLogin` is a thin wrapper over it. The trace lets the debug
 * harness (scripts/debug-resman-login.ts) and production see identical behavior
 * and tell a wrong password apart from a device/MFA/IP challenge — the two
 * failure modes that both collapse to `invalid_credentials`.
 *
 * Pass `captureHtml: true` to attach each step's raw HTML (offline debugging
 * only — never enable it on a path that logs, to avoid persisting tokens/PII).
 */
export async function traceResmanAdminLogin(
  username: string,
  password: string,
  config: ResmanAdminConfig = resolveResmanAdminConfig(),
  opts: {
    captureHtml?: boolean;
    onJar?: (jar: { serialize(): ResmanSessionCookie[] }) => void;
  } = {},
): Promise<ResmanLoginTrace> {
  const captureHtml = opts.captureHtml ?? false;
  const steps: ResmanLoginStepTrace[] = [];
  const jar = new CookieJar();
  opts.onJar?.(jar);
  try {
    // 1. Bootstrap → login page + CSRF token.
    const bootstrap = await fetchFollowing(jar, { url: config.consumerStartUrl, method: "GET" });
    const token = bootstrap.status === 200 ? extractRequestVerificationToken(bootstrap.text) : null;
    steps.push(
      summarizeStep("bootstrap", bootstrap, { csrfTokenFound: Boolean(token) }, captureHtml),
    );
    if (bootstrap.status !== 200) {
      return {
        steps,
        result: { ok: false, reason: "unavailable", detail: `bootstrap ${bootstrap.status}` },
      };
    }
    if (!token) {
      return { steps, result: { ok: false, reason: "unavailable", detail: "no CSRF token" } };
    }

    // 2. POST credentials.
    const loginUrl = bootstrap.finalUrl;
    const returnUrl = new URL(loginUrl).searchParams.get("ReturnUrl") ?? "";
    const credResult = await fetchFollowing(jar, {
      url: loginUrl,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: loginUrl,
        origin: config.authBaseUrl,
      },
      body: formURLEncode([
        ["AccountId", config.accountId],
        ["ReturnUrl", returnUrl],
        ["AdId", ""],
        ["CompanyName", config.companyName],
        ["Username", username],
        ["Password", password],
        ["__RequestVerificationToken", token],
      ]),
    });

    // 3. Replay the OIDC form_post. Invalid credentials re-render the login page
    //    (no auto-submit form_post to an absolute action) → treat as rejected.
    const formPost = parseOidcFormPost(credResult.text);
    steps.push(
      summarizeStep(
        "post-credentials",
        credResult,
        {
          formPostAction: formPost?.action ?? null,
          formPostFields: formPost?.fields.length ?? 0,
        },
        captureHtml,
      ),
    );
    if (!formPost || !/^https?:/i.test(formPost.action) || formPost.fields.length === 0) {
      return { steps, result: { ok: false, reason: "invalid_credentials" } };
    }
    const oidc = await fetchFollowing(jar, {
      url: formPost.action,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: config.authBaseUrl,
        referer: `${config.authBaseUrl}/`,
      },
      body: formURLEncode(formPost.fields),
    });

    // 4. Confirm we landed authenticated (not bounced back to a sign-in page).
    const landed = oidc.finalUrl.toLowerCase();
    steps.push(summarizeStep("oidc-replay", oidc, {}, captureHtml));
    if (landed.includes("/auth/account/login") || landed.includes("/access/signin")) {
      return { steps, result: { ok: false, reason: "invalid_credentials" } };
    }

    // 5. Cache the staff identity ResMan embeds in the landed app page (the
    //    hidden inputs live there; back-fill from the credential-POST response
    //    if a redirect swallowed them).
    const identity = mergeIdentity(
      extractLoggedInIdentity(oidc.text),
      extractLoggedInIdentity(credResult.text),
    );
    return { steps, result: { ok: true, username, identity } };
  } catch (error) {
    return {
      steps,
      result: {
        ok: false,
        reason: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Validate a ResMan staff username/password by running the full OIDC login.
 * Returns `{ ok: true }` on success, `invalid_credentials` when the login is
 * rejected, or `unavailable` on a network/portal error. Thin wrapper over
 * `traceResmanAdminLogin` that also logs the (non-sensitive) shape of the final
 * step on rejection, so Coolify logs distinguish a wrong password from a
 * device/MFA challenge.
 */
export async function validateResmanAdminLogin(
  username: string,
  password: string,
  config: ResmanAdminConfig = resolveResmanAdminConfig(),
): Promise<ResmanAdminLoginResult> {
  const { steps, result } = await traceResmanAdminLogin(username, password, config);
  if (!result.ok && result.reason === "invalid_credentials") {
    const last = steps[steps.length - 1];
    if (last) console.error("[resman-admin-login] rejected", { ...last, html: undefined });
  }
  return result;
}

export type ResmanAdminSessionResult =
  | { ok: true; username: string; identity: ResmanLoggedInIdentity; cookies: ResmanSessionCookie[] }
  | { ok: false; reason: "invalid_credentials" | "unavailable"; detail?: string };

/**
 * Run the full staff login and RETURN the session cookies — the server-side
 * half of the maintenance app's device-held session. The device's own login
 * dance fails on React Native's HTTP stack (field-verified: identical
 * algorithm succeeds from node), so the server performs the proven login and
 * hands the cookies over; the app injects them into its native cookie store
 * and the session lives on the device from then on. Cookies are returned to
 * the caller and NEVER persisted or logged here.
 */
export async function loginResmanAdminSession(
  username: string,
  password: string,
  config: ResmanAdminConfig = resolveResmanAdminConfig(),
): Promise<ResmanAdminSessionResult> {
  const box: { serialize: (() => ResmanSessionCookie[]) | null } = { serialize: null };
  const { steps, result } = await traceResmanAdminLogin(username, password, config, {
    onJar: (jar) => {
      box.serialize = () => jar.serialize();
    },
  });
  if (!result.ok) {
    if (result.reason === "invalid_credentials") {
      const last = steps[steps.length - 1];
      if (last)
        console.error("[resman-admin-login] session login rejected", { ...last, html: undefined });
    }
    return result;
  }
  return { ...result, cookies: box.serialize ? box.serialize() : [] };
}

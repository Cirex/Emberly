/**
 * ResManClient — one authenticated HTTP client per company. Port of
 * KrakenCore/Services/ResMan/ResManClient.swift (design §3.1/§3.2), with the
 * authentication built on the proven TypeScript OIDC/cookie logic already in
 * apps/web/lib/resman-portal.ts.
 *
 * Responsibilities:
 *   - a `fetch` wrapper with a persistent cookie jar and manual redirect
 *     following (so cookies set on intermediate hops are captured, the way the
 *     Swift URLSession's HTTPCookieStorage did);
 *   - the 3-step ResMan **staff** OIDC login (distinct from the resident-portal
 *     login in resman-portal.ts, but the same replay shape);
 *   - `isAuthenticated` / `ensureAuthenticated`;
 *   - the `data(...)` choke point through which every request passes, bounded by
 *     the request scheduler (concurrency = connectionsPerHost — the design §8
 *     politeness limit).
 *
 * Credentials are injected (design §5.4) — never read here from a hardcoded
 * value. Use `resManCredentialsFromEnv` to source them from the worker secrets.
 *
 * Live authentication is credential-gated: the OIDC round-trip cannot be
 * exercised without real staff credentials, so its network smoke test is
 * deferred (design §7, Milestone 2). The pure helpers (`extractToken`,
 * `formURLEncode`, `extractDXCss`, `completeOIDC` form parsing) are fully
 * offline-tested.
 */

import {
  MULTI_SOUTH_CONFIGURATION,
  RESMAN_SYNC_TUNING,
  type ResManConfiguration,
  type ResManCredentials,
} from "./config";
import { CookieJar } from "./cookies";
import { ResManScrapingError, isResManLoginRedirect } from "./errors";
import { ResManRequestScheduler } from "./scheduler";
import { ResManSessionStore } from "./session-store";

export type FetchLike = typeof fetch;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const MAX_REDIRECTS = 12;

// MARK: - Pure helpers (directly unit-tested)

/** Decode the HTML entities ResMan uses in form-action URLs. */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const TOKEN_PATTERNS: RegExp[] = [
  // hidden input — double quotes, both orderings
  /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
  /value="([^"]+)"[^>]*name="__RequestVerificationToken"/i,
  // hidden input — single quotes
  /name='__RequestVerificationToken'[^>]*value='([^']+)'/i,
  /value='([^']+)'[^>]*name='__RequestVerificationToken'/i,
  // <meta name="RequestVerificationToken" content="..."> (SPA pages)
  /name=['"]RequestVerificationToken['"][^>]*content=['"]([^'"]+)['"]/i,
  /content=['"]([^'"]+)['"][^>]*name=['"]RequestVerificationToken['"]/i,
];

/**
 * Extract the `__RequestVerificationToken` from a login/report page. ResMan
 * varies attribute order, quoting, and (on SPA pages) uses a `<meta>` tag, so
 * six variants are tried. Throws when none match. Port of
 * `ResManClient.extractToken`.
 */
export function extractRequestVerificationToken(html: string): string {
  for (const pattern of TOKEN_PATTERNS) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  throw ResManScrapingError.custom(
    `Could not find __RequestVerificationToken in HTML. Preview: ${html.slice(0, 800)}`,
  );
}

/**
 * Collect the DevExpress CSS/resource identifiers a report export must echo
 * back: every `.css`/`.ico` `<link href>` in document order, then each unique
 * `DXR.axd?r=<id>`. Joined with commas. Port of `ResManClient.extractDXCss`.
 */
export function extractDXCss(html: string): string {
  const items: string[] = [];

  const linkRegex = /<link[^>]*\bhref=['"]([^'"]+\.(?:css|ico)[^'"]*)['"]/gi;
  for (const match of html.matchAll(linkRegex)) {
    items.push(match[1]);
  }

  const dxrRegex = /DXR\.axd\?r=([A-Za-z0-9_]+)/g;
  const seen = new Set<string>();
  for (const match of html.matchAll(dxrRegex)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      items.push(id);
    }
  }

  return items.join(",");
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Percent-encode a single value with ResMan's restrictive allowed set
 * (`A-Za-z0-9-._~`), encoding everything else per UTF-8 byte — spaces become
 * `%20`, never `+`. ResMan's token/OIDC round-trip is sensitive to this exact
 * encoding, so it is reproduced rather than delegating to `encodeURIComponent`
 * (which leaves `!*'()` unencoded). Port of `ResManClient.formURLEncode`'s
 * per-pair encoder.
 */
function percentEncode(value: string): string {
  let out = "";
  const bytes = Buffer.from(value, "utf8");
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && UNRESERVED.test(ch)) {
      out += ch;
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** Form-url-encode key/value pairs (order preserved). Port of `formURLEncode`. */
export function formURLEncode(pairs: Array<[string, string]>): string {
  return pairs.map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join("&");
}

/** Parse the hidden inputs out of an auto-submitting OIDC `form_post` page. */
export function parseOidcFormPost(html: string): { action: string; fields: Array<[string, string]> } {
  const actionMatch = /action=["']([^"']+)["']/.exec(html);
  if (!actionMatch) {
    const preview = html.slice(0, 300).replace(/\n/g, " ");
    throw ResManScrapingError.custom(`No <form action> in response — ${preview}`);
  }
  const action = decodeHtmlEntities(actionMatch[1]);

  const fields: Array<[string, string]> = [];
  const inputRegex = /<input[^>]*\bname=['"]([^'"]+)['"][^>]*\bvalue=['"]([^'"]*)['"]/gi;
  for (const match of html.matchAll(inputRegex)) {
    fields.push([match[1], match[2]]);
  }
  return { action, fields };
}

// MARK: - Request/response types

export interface ResManRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /**
   * "manual" returns the FIRST response instead of following redirects —
   * cookies on that hop are still captured. The write path needs this: ResMan
   * answers a successful form POST with a redirect, and following it would
   * downgrade to GET and hand back the landing page instead of the save's own
   * status. Reads keep the default ("follow").
   */
  redirect?: "follow" | "manual";
}

export interface ResManResponse {
  status: number;
  finalUrl: string;
  contentType: string;
  headers: Headers;
  bytes: Uint8Array;
  text: string;
}

export interface ResManClientOptions {
  fetchImpl?: FetchLike;
  scheduler?: ResManRequestScheduler;
  sessionStore?: ResManSessionStore;
  credentials?: ResManCredentials;
  connectionsPerHost?: number;
  userAgent?: string;
  log?: (message: string) => void;
}

export class ResManClient {
  readonly configuration: ResManConfiguration;
  readonly userAgent: string;
  connectionsPerHost: number;

  private readonly fetchImpl: FetchLike;
  private readonly scheduler: ResManRequestScheduler;
  private readonly sessionStore: ResManSessionStore;
  private readonly credentials?: ResManCredentials;
  private readonly jar: CookieJar;
  private readonly log: (message: string) => void;
  private sessionLoaded = false;

  constructor(
    configuration: ResManConfiguration = MULTI_SOUTH_CONFIGURATION,
    options: ResManClientOptions = {},
  ) {
    this.configuration = configuration;
    this.connectionsPerHost =
      options.connectionsPerHost ?? RESMAN_SYNC_TUNING.defaultConnectionsPerHost;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.scheduler =
      options.scheduler ?? new ResManRequestScheduler(this.connectionsPerHost);
    this.sessionStore = options.sessionStore ?? new ResManSessionStore();
    this.credentials = options.credentials;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.log = options.log ?? (() => {});
    try {
      this.jar = new CookieJar(new URL(configuration.consumerStartUrl).hostname);
    } catch {
      this.jar = new CookieJar();
    }
  }

  /** Exposed for the session store / tests. */
  get cookieJar(): CookieJar {
    return this.jar;
  }

  // MARK: - The choke point

  /**
   * Every request passes through here: it is bounded by the request scheduler
   * (concurrency = connectionsPerHost), injects the cookie jar, and follows
   * redirects by hand so cookies set on each hop are captured. Port of
   * `ResManClient.data(for:label:)`.
   */
  async data(request: ResManRequest, label = ""): Promise<ResManResponse> {
    return this.scheduler.withPermit(() => this.fetchFollowing(request), {
      label,
      limit: this.connectionsPerHost,
    });
  }

  private async fetchFollowing(request: ResManRequest): Promise<ResManResponse> {
    let url = request.url;
    let method: "GET" | "POST" = request.method ?? "GET";
    let body = request.body;
    const baseHeaders = request.headers ?? {};

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const headers: Record<string, string> = {
        "user-agent": this.userAgent,
        accept: "text/html,application/xhtml+xml",
        ...baseHeaders,
      };
      const cookie = this.jar.cookieHeader();
      if (cookie) headers.cookie = cookie;
      if (body === undefined) delete headers["content-type"];

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: method === "POST" ? body : undefined,
          redirect: "manual",
        });
      } catch (error) {
        throw ResManScrapingError.networkError(error);
      }

      this.jar.ingestResponse(response.headers);

      const status = response.status;
      const location = response.headers.get("location");
      if (
        request.redirect !== "manual" &&
        status >= 300 &&
        status < 400 &&
        location &&
        hop < MAX_REDIRECTS
      ) {
        url = new URL(location, url).toString();
        // 303 always downgrades to GET; browsers also convert POST on 301/302.
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      const text = new TextDecoder("utf-8").decode(buffer);
      return {
        status,
        finalUrl: response.url || url,
        contentType: response.headers.get("content-type") ?? "",
        headers: response.headers,
        bytes: buffer,
        text,
      };
    }

    throw ResManScrapingError.custom(`Exceeded ${MAX_REDIRECTS} redirects for ${request.url}`);
  }

  // MARK: - Pure helper methods (parity with the Swift instance methods)

  extractToken(html: string): string {
    return extractRequestVerificationToken(html);
  }

  extractDXCss(html: string): string {
    return extractDXCss(html);
  }

  formURLEncode(pairs: Array<[string, string]>): string {
    return formURLEncode(pairs);
  }

  // MARK: - OIDC dance (design §3.2)

  /** Step 1: GET the consumer root, follow to the auth login page, read the token. */
  async bootstrapLogin(): Promise<{ loginUrl: string; html: string; token: string }> {
    const response = await this.data(
      { url: this.configuration.consumerStartUrl, method: "GET" },
      "GET bootstrap-login",
    );
    this.log(`[bootstrap] status=${response.status} finalURL=${response.finalUrl}`);
    if (response.status !== 200) {
      throw ResManScrapingError.custom(
        `Bootstrap failed (HTTP ${response.status}) at ${response.finalUrl}`,
      );
    }
    const token = extractRequestVerificationToken(response.text);
    return { loginUrl: response.finalUrl, html: response.text, token };
  }

  /** Step 2: POST the credentials to the login URL; returns the form_post HTML. */
  async postCredentials(params: {
    loginUrl: string;
    token: string;
    username: string;
    password: string;
  }): Promise<string> {
    const returnUrl = new URL(params.loginUrl).searchParams.get("ReturnUrl") ?? "";
    const body: Array<[string, string]> = [
      ["AccountId", this.configuration.accountId],
      ["ReturnUrl", returnUrl],
      ["AdId", ""],
      ["CompanyName", this.configuration.companyName],
      ["Username", params.username],
      ["Password", params.password],
      ["__RequestVerificationToken", params.token],
    ];

    const response = await this.data(
      {
        url: params.loginUrl,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: params.loginUrl,
          origin: this.configuration.authBaseUrl,
        },
        body: formURLEncode(body),
      },
      "POST credentials",
    );
    this.log(`[POST login] status=${response.status}`);
    return response.text;
  }

  /** Step 3: replay the auto-submitting OIDC form to set the session cookie. */
  async completeOIDC(formPostHtml: string): Promise<{ status: number; finalUrl: string }> {
    const { action, fields } = parseOidcFormPost(formPostHtml);
    if (!/^https?:/i.test(action)) {
      throw ResManScrapingError.custom("Invalid username or password");
    }
    if (fields.length === 0) {
      throw ResManScrapingError.custom("form_post had no hidden inputs");
    }

    const response = await this.data(
      {
        url: action,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: this.configuration.authBaseUrl,
          referer: `${this.configuration.authBaseUrl}/`,
        },
        body: formURLEncode(fields),
      },
      "POST signin-oidc",
    );
    this.log(`[POST signin-oidc] status=${response.status} finalURL=${response.finalUrl}`);
    return { status: response.status, finalUrl: response.finalUrl };
  }

  /** Full staff login (bootstrap → credentials → OIDC). */
  async login(username: string, password: string): Promise<void> {
    const { loginUrl, token } = await this.bootstrapLogin();
    const formPostHtml = await this.postCredentials({ loginUrl, token, username, password });
    await this.completeOIDC(formPostHtml);
  }

  /** True unless the consumer root redirects us back to a login page. */
  async isAuthenticated(): Promise<boolean> {
    try {
      const response = await this.data(
        { url: this.configuration.consumerStartUrl, method: "GET" },
        "GET auth-check",
      );
      return !isResManLoginRedirect(response.finalUrl);
    } catch {
      return false;
    }
  }

  /**
   * Load the persisted session (once), then log in only if the current session
   * is not authenticated, saving the fresh session afterward. Requires injected
   * credentials (via constructor options or the explicit argument). Port of
   * `ResManClient.ensureAuthenticated`.
   */
  async ensureAuthenticated(
    credentials: ResManCredentials | undefined = this.credentials,
    staleLogMessage = "[auth] session stale — re-authenticating",
  ): Promise<void> {
    if (!credentials) {
      throw ResManScrapingError.custom(
        "ResMan credentials not configured (design §5.4) — pass them to the client.",
      );
    }
    if (!this.sessionLoaded) {
      await this.sessionStore.load(this.jar, this.log);
      this.sessionLoaded = true;
    }
    if (!(await this.isAuthenticated())) {
      this.log(staleLogMessage);
      await this.login(credentials.username, credentials.password);
      await this.sessionStore.save(this.jar, this.log);
    }
  }

  // MARK: - Session persistence passthroughs

  async saveSession(): Promise<void> {
    await this.sessionStore.save(this.jar, this.log);
  }

  async loadSession(): Promise<void> {
    await this.sessionStore.load(this.jar, this.log);
    this.sessionLoaded = true;
  }

  async clearSession(): Promise<void> {
    await this.sessionStore.clear(this.jar, this.log);
    this.sessionLoaded = false;
  }
}

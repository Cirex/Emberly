/**
 * MLGW HTTP client, cookie jar, retry/backoff, and bounded concurrency.
 *
 * Ports:
 *   - MLGWHTTPClient.swift    -> MLGWHTTPClient (fetch-based; manual redirects)
 *   - MLGWHTTPCookieJar.swift -> MLGWHTTPCookieJar (explicit Set-Cookie jar)
 *   - MLGWNetworkRetry.swift  -> withTransientNetworkRetries, retryDelay,
 *                                sleepWithCancellation, isCancellationError
 *
 * Networking uses the global `fetch` (Bun/undici). Like the ResMan client, we
 * keep a single explicit cookie jar and follow redirects by hand (up to 12) so
 * cookies set on intermediate hops are captured, 303 / POST-30x downgrade to
 * GET (dropping Content-Type + body), and `AbortController` enforces the
 * per-request timeout. `mapWithConcurrency` replaces the Swift worker pools
 * (brief §6).
 */

import { RequestScheduler } from "../shared/request-scheduler";
import {
  configuredConcurrency,
  configuredHTTPTimeout,
  debugLog,
  errorDescriptionLooksTransient,
  formattedDuration,
  readableErrorDescription,
} from "./env";
import {
  CancellationError,
  type HTTPResponse,
  MLGWScriptCancellation,
  MLGWStoredCookie,
  ScriptError,
} from "./types";

const MAX_REDIRECTS = 12;

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://mymlgw.mlgw.org/",
};

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

/** Trim whitespace/newlines and normalize NBSP to a space. Port of `trimmedForCell`. */
function trimmedForCell(value: string): string {
  return value.trim().replace(/\u00a0/g, " ");
}

// MARK: - Cookie jar (MLGWHTTPCookieJar.swift)

/**
 * An explicit Set-Cookie jar keyed by `domain|path|name`. Faithful port of the
 * Swift `MLGWHTTPCookieJar`: it splits folded Set-Cookie headers, stores cookies
 * with domain/path/secure attributes, and builds the request `Cookie:` header
 * from the cookies that apply to a URL.
 */
export class MLGWHTTPCookieJar {
  private explicitCookies: Map<string, MLGWStoredCookie>;

  constructor(explicitCookies: Map<string, MLGWStoredCookie> = new Map()) {
    this.explicitCookies = explicitCookies;
  }

  /** `name=value; …` for every stored cookie that applies to `url`, sorted. */
  explicitCookieHeader(url: URL): string {
    return [...this.explicitCookies.values()]
      .filter((cookie) => cookie.applies(url))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .sort()
      .join("; ");
  }

  /** Capture every Set-Cookie from a response's headers. */
  captureCookies(setCookieHeaders: string[], url: URL): void {
    for (const header of setCookieHeaders) {
      this.storeCookie(header, url);
    }
  }

  /** Capture Set-Cookie from a `fetch` `Headers`, preferring `getSetCookie()`. */
  captureFromHeaders(headers: Headers, url: URL): void {
    this.captureCookies(getSetCookieHeaders(headers), url);
  }

  /** A shallow copy of the stored cookies (for `copyForConcurrentRequests`). */
  snapshot(): Map<string, MLGWStoredCookie> {
    return new Map(this.explicitCookies);
  }

  private storeCookie(header: string, url: URL): void {
    const segments = header.split(";").map((s) => trimmedForCell(s));
    const first = segments[0];
    if (first === undefined) return;
    const equals = first.indexOf("=");
    if (equals < 0) return;
    const host = url.hostname.toLowerCase();
    if (host.length === 0) return;

    const name = first.slice(0, equals);
    const value = first.slice(equals + 1);
    if (name.length === 0) return;

    let domain = host;
    let path = "/";
    let secure = false;

    for (const segment of segments.slice(1)) {
      const lower = segment.toLowerCase();
      if (lower === "secure") {
        secure = true;
      } else if (lower.startsWith("domain=")) {
        domain = segment.slice("domain=".length).toLowerCase();
      } else if (lower.startsWith("path=")) {
        path = segment.slice("path=".length);
        if (path.length === 0) path = "/";
      }
    }

    this.explicitCookies.set(
      `${domain}|${path}|${name}`,
      new MLGWStoredCookie(name, value, domain, path, secure),
    );
  }
}

/**
 * Split a (possibly folded) `Set-Cookie` header into individual cookies,
 * preferring the WHATWG `Headers.getSetCookie()` and falling back to the byte
 * scanner. The fallback mirrors the Swift `splitSetCookieHeader`: it only splits
 * on a comma when the following text looks like `name=` and never inside an
 * `Expires=` date.
 */
export function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const explicit = withGetSetCookie.getSetCookie?.();
  if (explicit && explicit.length > 0) return explicit;
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

/** Faithful port of the Swift `splitSetCookieHeader` byte scanner. */
export function splitSetCookieHeader(raw: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  let inExpires = false;

  while (index < raw.length) {
    const lowerTail = raw.slice(index).toLowerCase();
    if (lowerTail.startsWith("expires=")) {
      inExpires = true;
    }
    const char = raw[index];
    if (inExpires && char === ";") {
      inExpires = false;
    }
    if (char === "," && !inExpires) {
      const remainder = raw.slice(index + 1);
      if (/^\s*[^=;,\s]+=/.test(remainder)) {
        parts.push(trimmedForCell(raw.slice(start, index)));
        start = index + 1;
      }
    }
    index += 1;
  }
  parts.push(trimmedForCell(raw.slice(start)));
  return parts.filter((part) => part.length > 0);
}

// MARK: - HTTP client (MLGWHTTPClient.swift)

export interface MLGWRequestOptions {
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Per-request timeout in milliseconds; defaults to `MLGW_HTTP_REQUEST_TIMEOUT` (45s). */
  timeoutMs?: number;
}

export interface MLGWHTTPClientOptions {
  fetchImpl?: typeof fetch;
  cookieJar?: MLGWHTTPCookieJar;
  /**
   * Shared request scheduler bounding total in-flight requests. When omitted a
   * new one is created at the `MLGW_CONNECTIONS_PER_HOST` ceiling (default 6);
   * `copyForConcurrentRequests` passes the SAME instance to every copy, so the
   * ceiling holds across all concurrent workers regardless of pool nesting.
   */
  scheduler?: RequestScheduler;
}

/** Default max concurrent MLGW requests (env-overridable via MLGW_CONNECTIONS_PER_HOST). */
const DEFAULT_MLGW_CONNECTIONS_PER_HOST = 6;

/**
 * The shared MLGW HTTP client. `request` applies the default browser-like
 * headers, merges the explicit cookie header, follows up to 12 redirects by
 * hand, captures Set-Cookie into the jar on every hop, and returns a fully
 * materialized `HTTPResponse` (text + bytes + `isPdf`).
 */
export class MLGWHTTPClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cookieJar: MLGWHTTPCookieJar;
  private readonly scheduler: RequestScheduler;

  constructor(options: MLGWHTTPClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cookieJar = options.cookieJar ?? new MLGWHTTPCookieJar();
    this.scheduler =
      options.scheduler ??
      new RequestScheduler(
        configuredConcurrency("MLGW_CONNECTIONS_PER_HOST", DEFAULT_MLGW_CONNECTIONS_PER_HOST),
      );
  }

  /** Exposed for the session layer / tests. */
  get jar(): MLGWHTTPCookieJar {
    return this.cookieJar;
  }

  async request(
    method: string,
    url: string | URL,
    options: MLGWRequestOptions = {},
  ): Promise<HTTPResponse> {
    // Bound total in-flight requests through the shared scheduler. One permit
    // covers the whole logical request (including redirect hops), matching the
    // ResMan client, so nested worker pools can never exceed the ceiling.
    return this.scheduler.withPermit(() => this.requestFollowingRedirects(method, url, options));
  }

  private async requestFollowingRedirects(
    method: string,
    url: string | URL,
    options: MLGWRequestOptions,
  ): Promise<HTTPResponse> {
    const timeoutMs = options.timeoutMs ?? configuredHTTPTimeout("MLGW_HTTP_REQUEST_TIMEOUT", 45000);

    let currentMethod = method.toUpperCase();
    let currentURL = new URL(url.toString());
    const currentHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    let currentBody: string | Uint8Array | undefined = options.body;

    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const response = await this.singleRequest(
        currentMethod,
        currentURL,
        currentHeaders,
        currentBody,
        timeoutMs,
      );

      const location = response.headers["location"];
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        const nextURL = new URL(location, response.url);
        currentURL = nextURL;
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && currentMethod === "POST")
        ) {
          currentMethod = "GET";
          currentBody = undefined;
          delete currentHeaders["Content-Type"];
          delete currentHeaders["content-type"];
        }
        continue;
      }

      return response;
    }

    throw ScriptError.badResponse(`Too many redirects from ${new URL(url.toString()).toString()}`);
  }

  private async singleRequest(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
    timeoutMs: number,
  ): Promise<HTTPResponse> {
    const requestHeaders: Record<string, string> = { ...DEFAULT_HEADERS };
    const explicitCookie = this.cookieJar.explicitCookieHeader(url);
    if (explicitCookie.length > 0) {
      requestHeaders["Cookie"] = explicitCookie;
    }
    // Caller headers win over the defaults (matching the Swift ordering).
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders[key] = value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let raw: Response;
    try {
      raw = await this.fetchImpl(url.toString(), {
        method,
        headers: requestHeaders,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const finalURL = raw.url && raw.url.length > 0 ? raw.url : url.toString();
    const responseHeaders: Record<string, string> = {};
    raw.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    this.cookieJar.captureFromHeaders(raw.headers, new URL(finalURL));

    const bytes = new Uint8Array(await raw.arrayBuffer());
    const text = decodeBody(bytes);
    const contentType = (responseHeaders["content-type"] ?? "").toLowerCase();
    const isPdf = contentType.includes("pdf") || startsWith(bytes, PDF_MAGIC);

    return {
      status: raw.status,
      headers: responseHeaders,
      url: finalURL,
      text,
      bytes,
      isPdf,
    };
  }

  /**
   * A new client sharing a snapshot of this client's cookies, for use on a
   * concurrent worker. Port of `copyForConcurrentRequests`.
   */
  copyForConcurrentRequests(): MLGWHTTPClient {
    return new MLGWHTTPClient({
      fetchImpl: this.fetchImpl,
      cookieJar: new MLGWHTTPCookieJar(this.cookieJar.snapshot()),
      // Share the SAME scheduler so the concurrency ceiling spans all copies.
      scheduler: this.scheduler,
    });
  }
}

/** Decode response bytes as UTF-8, matching the Swift utf8 → isoLatin1 fallback. */
function decodeBody(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

// MARK: - Retry / backoff (MLGWNetworkRetry.swift)

/** An error that must abort rather than retry (cancellation / abort). */
export function isCancellationError(error: unknown): boolean {
  if (error instanceof CancellationError) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Whether an error looks like a retryable network blip. In TS there is no
 * `NSError` domain/code, so this reduces to the textual heuristic from
 * `env.errorDescriptionLooksTransient`.
 */
export function isTransientNetworkError(error: unknown): boolean {
  return errorDescriptionLooksTransient(error);
}

/** Exponential backoff in **milliseconds**, capped at 2000ms. Port of `retryDelay(forAttempt:)`. */
export function retryDelay(attempt: number): number {
  const multiplier = 1 << Math.min(Math.max(attempt - 1, 0), 3);
  return Math.min(2000, 350 * multiplier);
}

/** Sleep `ms`, checking the cancellation token before and after. */
export async function sleepWithCancellation(
  ms: number,
  cancellation?: MLGWScriptCancellation,
): Promise<void> {
  cancellation?.check();
  if (ms > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  cancellation?.check();
}

export interface RetryOptions {
  maxAttempts?: number;
  cancellation?: MLGWScriptCancellation;
  debugLabel?: string;
}

/**
 * Run `operation`, retrying on transient network errors with backoff (up to
 * `maxAttempts`, default 4). Cancellation errors abort immediately. Port of the
 * Swift `withTransientNetworkRetries`.
 */
export async function withTransientNetworkRetries<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.cancellation?.check();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (isCancellationError(error)) {
        throw error;
      }
      if (attempt >= maxAttempts || !isTransientNetworkError(error)) {
        throw error;
      }
      const delay = retryDelay(attempt);
      if (options.debugLabel) {
        debugLog(
          `${options.debugLabel}: attempt ${attempt} failed with ${readableErrorDescription(
            error,
          )}; retrying in ${formattedDuration(delay)}.`,
        );
      }
      await sleepWithCancellation(delay, options.cancellation);
    }
  }

  throw lastError ?? ScriptError.badResponse("MLGW request failed without a response.");
}

// MARK: - Bounded concurrency (brief §6)

/**
 * Map `items` with at most `limit` concurrent invocations of `fn`, preserving
 * input order in the result. Replaces the Swift detached-task worker pools.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

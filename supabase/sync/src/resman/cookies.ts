/**
 * Cookie jar for the ResMan client — a persistent per-company store of the
 * session cookies the OIDC login sets. Design §3.2 ("maintain a per-company
 * cookie jar; persist it between cron runs").
 *
 * The Set-Cookie parsing here is lifted directly from the proven web
 * portal-adapter (apps/web/lib/resman-portal.ts): `getSetCookie()` with a
 * split fallback, merge-by-name, and the request `Cookie:` header builder. The
 * Swift client leaned on URLSession's HTTPCookieStorage; in Node we keep an
 * explicit jar so the same implementation drives both requests and the session
 * store. ResMan is a single host per company, so cookies are keyed by name.
 */

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch milliseconds, or null for a session cookie. */
  expires: number | null;
  secure: boolean;
}

/** Split a folded `Set-Cookie` header back into individual cookies. */
function splitSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Prefer the WHATWG `getSetCookie()`; fall back to splitting the folded header. */
export function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const explicit = withGetSetCookie.getSetCookie?.();
  if (explicit && explicit.length > 0) return explicit;
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

/** Parse one `Set-Cookie` header line into a StoredCookie. */
export function parseSetCookie(header: string, defaultDomain: string): StoredCookie | null {
  const [pair, ...rawAttrs] = header.split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  if (separator < 0) return null;
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);

  const attrs = new Map<string, string | true>();
  for (const rawAttr of rawAttrs) {
    const eq = rawAttr.indexOf("=");
    if (eq < 0) {
      attrs.set(rawAttr.toLowerCase(), true);
    } else {
      attrs.set(rawAttr.slice(0, eq).toLowerCase(), rawAttr.slice(eq + 1));
    }
  }

  let expires: number | null = null;
  const maxAge = attrs.get("max-age");
  if (typeof maxAge === "string") {
    const seconds = Number.parseInt(maxAge, 10);
    if (Number.isFinite(seconds)) expires = Date.now() + seconds * 1000;
  } else if (typeof attrs.get("expires") === "string") {
    const parsed = Date.parse(attrs.get("expires") as string);
    if (Number.isFinite(parsed)) expires = parsed;
  }

  const domainAttr = attrs.get("domain");
  const pathAttr = attrs.get("path");
  return {
    name,
    value,
    domain: typeof domainAttr === "string" ? domainAttr.replace(/^\./, "") : defaultDomain,
    path: typeof pathAttr === "string" ? pathAttr : "/",
    expires,
    secure: attrs.has("secure"),
  };
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  private readonly defaultDomain: string;

  constructor(defaultDomain = "multisouth.myresman.com") {
    this.defaultDomain = defaultDomain;
  }

  /** Ingest all `Set-Cookie` headers from a response (merge by name). */
  ingestResponse(headers: Headers): void {
    this.ingestSetCookieHeaders(getSetCookieHeaders(headers));
  }

  ingestSetCookieHeaders(headers: string[]): void {
    for (const header of headers) {
      const cookie = parseSetCookie(header, this.defaultDomain);
      if (cookie) this.cookies.set(cookie.name, cookie);
    }
  }

  setCookie(cookie: StoredCookie): void {
    this.cookies.set(cookie.name, cookie);
  }

  /** Build the `Cookie:` request header from the live (non-expired) cookies. */
  cookieHeader(now: number = Date.now()): string {
    return this.liveCookies(now)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private liveCookies(now: number): StoredCookie[] {
    return Array.from(this.cookies.values()).filter(
      (cookie) => cookie.expires === null || cookie.expires > now,
    );
  }

  all(): StoredCookie[] {
    return Array.from(this.cookies.values());
  }

  isEmpty(): boolean {
    return this.cookies.size === 0;
  }

  clear(): void {
    this.cookies.clear();
  }

  /** Serialize for persistence (session store). */
  serialize(): StoredCookie[] {
    return this.all();
  }

  /** Replace the jar contents with previously serialized cookies. */
  load(stored: StoredCookie[]): void {
    this.cookies.clear();
    for (const cookie of stored) this.cookies.set(cookie.name, cookie);
  }
}

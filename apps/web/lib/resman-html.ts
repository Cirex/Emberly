/**
 * Shared HTML + Set-Cookie parsing for the ResMan login flows.
 *
 * Both the resident-portal login (lib/resman-portal.ts) and the staff OIDC login
 * (lib/resman-admin-login.ts) scrape the same ResMan markup and juggle the same
 * Set-Cookie quirks. These are auth-critical, quote/order-tolerant parsers with
 * dedicated coverage in tests/resman-html.test.js — keep them in sync with real
 * ResMan responses and covered by tests.
 */

/**
 * Decode the five HTML entities ResMan emits in attribute values and text
 * ("D&#39;Angelo O&amp;B" → "D'Angelo O&B"). Order is inherited from the
 * resident-portal decoder this was extracted from; ResMan only ever single-
 * encodes, so every ordering produces identical output on real input.
 */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Split a comma-combined Set-Cookie header back into individual cookies. The
 * lookahead only breaks before a `name=value` pair, so commas inside an
 * `Expires=Wed, 09 Jun 2021 ...` attribute don't cause a bad split.
 */
export function splitSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Read Set-Cookie headers, preferring the structured `getSetCookie()` API and
 * falling back to splitting the combined header on runtimes that lack it.
 */
export function getSetCookieHeaders(headers: Headers): string[] {
  const headersWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const explicit = headersWithGetSetCookie.getSetCookie?.();
  if (explicit?.length) return explicit;

  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

/**
 * Read a hidden input's value by name, tolerant of attribute order and quote
 * style. Returns the raw (still entity-encoded) value, or null when absent.
 */
export function hiddenInputValue(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`name=["']${name}["'][^>]*\\bvalue=["']([^"']*)["']`, "i"),
    new RegExp(`value=["']([^"']*)["'][^>]*\\bname=["']${name}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match && match[1]) return match[1];
  }
  return null;
}

const REQUEST_VERIFICATION_TOKEN_PATTERNS: RegExp[] = [
  /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
  /value="([^"]+)"[^>]*name="__RequestVerificationToken"/i,
  /name='__RequestVerificationToken'[^>]*value='([^']+)'/i,
  /value='([^']+)'[^>]*name='__RequestVerificationToken'/i,
  /name=['"]RequestVerificationToken['"][^>]*content=['"]([^'"]+)['"]/i,
  /content=['"]([^'"]+)['"][^>]*name=['"]RequestVerificationToken['"]/i,
];

/**
 * Extract the anti-forgery token ResMan renders as either a hidden
 * `__RequestVerificationToken` input or a `RequestVerificationToken` meta tag,
 * tolerant of attribute order and quote style. Returns null when absent.
 */
export function extractRequestVerificationToken(html: string): string | null {
  for (const pattern of REQUEST_VERIFICATION_TOKEN_PATTERNS) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  return null;
}

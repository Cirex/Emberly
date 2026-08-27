/**
 * ResMan staff-portal authentication primitives — the pure halves of the
 * 3-step OIDC login (bootstrap → credentials → form_post replay), shared by
 * the sync worker's node client and the maintenance app's on-device session.
 *
 * Framework-free by design: no Buffer (TextEncoder does UTF-8), no fetch —
 * callers own the transport, because the two runtimes differ in exactly the
 * ways that matter (node fetch drops cookies and needs manual redirect
 * following; React Native's native stack persists cookies and auto-follows).
 * What CAN be shared is everything else: the portal constants, the CSRF token
 * harvest, the credential body, the auto-submitting form_post parse, the
 * percent-encoding ResMan's round-trip is sensitive to, and the
 * login-redirect detection.
 */

// MARK: - Portal constants

export interface ResManStaffPortal {
  readonly subdomain: string;
  /** e.g. https://multisouth.myresman.com/ (trailing slash — used as a base URL). */
  readonly consumerStartUrl: string;
  /** e.g. https://multisouth.auth.myresman.com (no trailing slash). */
  readonly authBaseUrl: string;
  readonly accountId: string;
  readonly companyName: string;
}

/** The single-company portal (account 1659) — same values the sync worker uses. */
export const MULTI_SOUTH_STAFF_PORTAL: ResManStaffPortal = {
  subdomain: "multisouth",
  consumerStartUrl: "https://multisouth.myresman.com/",
  authBaseUrl: "https://multisouth.auth.myresman.com",
  accountId: "1659",
  companyName: "The Multi-South Group",
};

/**
 * The URL paths ResMan redirects to when a request is not authenticated —
 * `isAuthenticated` checks and the write path's session guard both key on
 * them.
 */
export const RESMAN_LOGIN_REDIRECT_MARKERS = ["/auth/Account/Login", "/Access/SignIn"] as const;

export function isResManLoginRedirectUrl(finalUrl: string): boolean {
  return RESMAN_LOGIN_REDIRECT_MARKERS.some((marker) => finalUrl.includes(marker));
}

// MARK: - HTML entity decoding (ResMan's attribute/body spellings)

/** Decode the HTML entities ResMan uses in form-action URLs and attributes. */
export function decodeResManHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// MARK: - Percent encoding (ResMan's restrictive allowed set)

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** UTF-8 encode a string without Buffer or TextEncoder — core targets ES2017
 *  so this runs identically under node, bun, and Hermes. */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let code = value.charCodeAt(i);
    // Recombine surrogate pairs into the astral code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/**
 * Percent-encode a single value with ResMan's restrictive allowed set
 * (`A-Za-z0-9-._~`), encoding everything else per UTF-8 byte — spaces become
 * `%20`, never `+`. ResMan's token/OIDC round-trip is sensitive to this exact
 * encoding, so it is reproduced rather than delegating to
 * `encodeURIComponent` (which leaves `!*'()` unencoded).
 */
export function resManPercentEncode(value: string): string {
  let out = "";
  for (const byte of utf8Bytes(value)) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && UNRESERVED.test(ch)) {
      out += ch;
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** Form-url-encode key/value pairs (order preserved). */
export function resManFormURLEncode(pairs: Array<[string, string]>): string {
  return pairs.map(([key, value]) => `${resManPercentEncode(key)}=${resManPercentEncode(value)}`).join("&");
}

// MARK: - CSRF token harvest

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
 * six variants are tried. Returns null when none match — callers decide
 * whether that is fatal.
 */
export function extractResManVerificationToken(html: string): string | null {
  for (const pattern of TOKEN_PATTERNS) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  return null;
}

// MARK: - The credential POST body

/**
 * The exact field set the staff login form posts. `returnUrl` comes off the
 * login page's own URL (`?ReturnUrl=…`, already percent-encoded there — pass
 * it DECODED; the encoder re-encodes).
 */
export function buildStaffCredentialBody(params: {
  portal: ResManStaffPortal;
  returnUrl: string;
  username: string;
  password: string;
  token: string;
}): string {
  return resManFormURLEncode([
    ["AccountId", params.portal.accountId],
    ["ReturnUrl", params.returnUrl],
    ["AdId", ""],
    ["CompanyName", params.portal.companyName],
    ["Username", params.username],
    ["Password", params.password],
    ["__RequestVerificationToken", params.token],
  ]);
}

// MARK: - The auto-submitting form_post

export interface OidcFormPost {
  action: string;
  fields: Array<[string, string]>;
}

/**
 * Parse the hidden inputs out of an auto-submitting OIDC `form_post` page.
 * Returns null when there is no form action — for the credential step that
 * means the username/password were rejected (ResMan re-renders the login page
 * instead of the form_post).
 */
export function parseOidcFormPostPage(html: string): OidcFormPost | null {
  const actionMatch = /action=["']([^"']+)["']/.exec(html);
  if (!actionMatch) return null;
  const action = decodeResManHtmlEntities(actionMatch[1]);

  const fields: Array<[string, string]> = [];
  const inputRegex = /<input[^>]*\bname=['"]([^'"]+)['"][^>]*\bvalue=['"]([^'"]*)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRegex.exec(html)) !== null) {
    fields.push([match[1], match[2]]);
  }
  return { action, fields };
}

/**
 * True when a form_post parse indicates the credentials were accepted: the
 * action is an absolute URL (the signin-oidc endpoint) and hidden fields are
 * present. A relative action means ResMan re-rendered its own login form —
 * wrong username or password.
 */
export function oidcFormPostLooksValid(formPost: OidcFormPost | null): formPost is OidcFormPost {
  return formPost !== null && /^https?:/i.test(formPost.action) && formPost.fields.length > 0;
}

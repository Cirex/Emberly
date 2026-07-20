import { decodeHtmlEntities, getSetCookieHeaders } from "./resman-html";

const DEFAULT_ORIGIN = "https://multisouth.myresman.com";
const DEFAULT_SIGN_IN_PATH = "/Portal/Access/SignIn/Emberly";
const DEFAULT_TRANSACTIONS_PATH = "/Portal/Transactions";
const USER_AGENT =
  "Mozilla/5.0 (compatible; EmberlySecurity/1.0; +https://emberly.krkn.app)";
const ALLOWED_PORTAL_STATUSES = ["Current", "Pending Renewal", "Under Eviction"];
const DEVELOPMENT_ALLOWED_PORTAL_STATUSES = ["Approved"];

// Production default: only the real base statuses are admitted. To let
// "Approved" (not-yet-moved-in) residents sign in for testing, set
// RESIDENT_ALLOWED_PORTAL_STATUSES=Approved in that environment rather than
// flipping this — a hardcoded `true` shipped the test gate to every deploy.
const FORCE_DEV_LOGIN_GATE = false;

// Extra portal statuses to admit, from RESIDENT_ALLOWED_PORTAL_STATUSES (comma-
// separated, e.g. "Approved,Future"). Additive only — the base statuses above
// are always allowed, so this can widen access for testing but never lock out a
// real resident. Case-insensitive match against ResMan's status text.
function extraAllowedPortalStatuses(): string[] {
  return (process.env.RESIDENT_ALLOWED_PORTAL_STATUSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ParsedSignInForm {
  action: string;
  fields: Record<string, string>;
}

export interface ResmanClientCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

export interface ResmanPortalSession {
  baseUrl: string;
  signInUrl: string;
  cookieHeader: string;
  cookies: ResmanClientCookie[];
  issuedAt: string;
}

export interface ResmanPortalLoginResult {
  success: boolean;
  session?: ResmanPortalSession;
  tenantName?: string;
  error?: "invalid_credentials" | "portal_unavailable" | "unexpected_response";
  status?: number;
}

export interface ResmanPortalAccess {
  allowed: boolean;
  ledgerId?: string;
  tenantName?: string;
  unitNumber?: string;
  status?: string;
  error?: "transactions_unavailable" | "unit_status_not_found" | "resman_origin_not_allowed";
}

type FetchLike = typeof fetch;

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  for (const match of tag.matchAll(attrPattern)) {
    const [, rawName, doubleQuoted, singleQuoted, bare] = match;
    attrs[rawName.toLowerCase()] = decodeHtmlEntities(doubleQuoted ?? singleQuoted ?? bare ?? "");
  }

  return attrs;
}

export function parseSignInForm(html: string): ParsedSignInForm {
  const formMatch = html.match(/<form\b[^>]*\baction=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/i);
  if (!formMatch) {
    throw new Error("ResMan sign-in form was not found");
  }

  const action = decodeHtmlEntities(formMatch[1] ?? formMatch[2] ?? formMatch[3] ?? "");
  const fields: Record<string, string> = {};
  const inputPattern = /<input\b[^>]*>/gi;

  for (const inputMatch of html.matchAll(inputPattern)) {
    const attrs = parseAttributes(inputMatch[0]);
    const name = attrs.name;
    if (name) {
      fields[name] = attrs.value ?? "";
    }
  }

  for (const required of ["AccountID", "PropertyID", "PropertyName", "__RequestVerificationToken"]) {
    if (!(required in fields)) {
      throw new Error(`ResMan sign-in form is missing ${required}`);
    }
  }

  return { action, fields };
}

function cookieName(setCookieHeader: string): string {
  return setCookieHeader.split("=", 1)[0].trim();
}

function mergeSetCookieHeaders(...sets: string[][]): string[] {
  const merged = new Map<string, string>();
  for (const set of sets) {
    for (const header of set) {
      merged.set(cookieName(header), header);
    }
  }
  return Array.from(merged.values());
}

export function buildCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((header) => header.split(";", 1)[0].trim())
    .filter(Boolean)
    .join("; ");
}

export function serializeCookiesForClient(
  setCookieHeaders: string[],
  domain = "multisouth.myresman.com"
): ResmanClientCookie[] {
  return setCookieHeaders.map((header) => {
    const [pair, ...rawAttrs] = header.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const attrs = new Map<string, string | true>();

    for (const rawAttr of rawAttrs) {
      const [rawName, ...rawValue] = rawAttr.split("=");
      attrs.set(rawName.toLowerCase(), rawValue.length > 0 ? rawValue.join("=") : true);
    }

    return {
      name,
      value,
      domain: String(attrs.get("domain") ?? domain),
      path: String(attrs.get("path") ?? "/"),
      secure: attrs.has("secure"),
      httpOnly: attrs.has("httponly"),
    };
  });
}

export function isSuccessfulResmanLogin(status: number, location: string | null): boolean {
  if (status < 300 || status > 399 || !location) return false;
  return !location.toLowerCase().includes("/portal/access/signin");
}

export function getAllowedPortalStatuses(): string[] {
  const base =
    FORCE_DEV_LOGIN_GATE || process.env.NODE_ENV === "development"
      ? [...ALLOWED_PORTAL_STATUSES, ...DEVELOPMENT_ALLOWED_PORTAL_STATUSES]
      : [...ALLOWED_PORTAL_STATUSES];
  const all = [...base, ...extraAllowedPortalStatuses()];
  // De-dupe case-insensitively while keeping the first-seen casing for display.
  const seen = new Set<string>();
  return all.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isAllowedPortalStatus(status: string): boolean {
  const target = status.trim().toLowerCase();
  return getAllowedPortalStatuses().some((s) => s.toLowerCase() === target);
}

function configuredPortalOrigin(): string {
  return new URL(process.env.RESMAN_PORTAL_ORIGIN ?? DEFAULT_ORIGIN).origin;
}

export function isAllowedResmanPortalSession(session: ResmanPortalSession): boolean {
  try {
    const allowedOrigin = configuredPortalOrigin();
    return (
      new URL(session.baseUrl).origin === allowedOrigin &&
      new URL(session.signInUrl).origin === allowedOrigin
    );
  } catch {
    return false;
  }
}

function decodeHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseResidentNameFromPortalHtml(html: string): string | undefined {
  const loggedInPersonName =
    parseAttributes(
      html.match(/<input\b[^>]*\bname=(?:"LoggedInPersonName"|'LoggedInPersonName'|LoggedInPersonName)[^>]*>/i)?.[0] ?? ""
    ).value?.trim() || undefined;

  if (loggedInPersonName) return loggedInPersonName;

  const headerRight = html.match(/<div\b[^>]*\bid=(?:"HeaderRight"|'HeaderRight'|HeaderRight)[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if (!headerRight) return loggedInPersonName;

  const rawSpan = headerRight.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1];
  if (!rawSpan) return loggedInPersonName;

  const withoutImpersonation = rawSpan.replace(
    /<span\b[^>]*\bclass=(?:"[^"]*\bhidden-xs-down\b[^"]*"|'[^']*\bhidden-xs-down\b[^']*')[^>]*>[\s\S]*?<\/span>/gi,
    ""
  );
  const name = decodeHtmlText(withoutImpersonation).replace(/\s*\(Impersonated\)\s*$/i, "").trim();
  return name || loggedInPersonName;
}

export function parseTransactionsAccess(html: string): ResmanPortalAccess {
  const headingMatches = Array.from(html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi));
  const tenantName = parseResidentNameFromPortalHtml(html);
  const ledgerId =
    parseAttributes(
      html.match(/<input\b[^>]*\bname=(?:"UnitLeaseGroupID"|'UnitLeaseGroupID'|UnitLeaseGroupID)[^>]*>/i)?.[0] ?? ""
    ).value?.trim() || undefined;

  for (const headingMatch of headingMatches) {
    const heading = decodeHtmlText(headingMatch[1]);
    const unitMatch = heading.match(/^Unit\s+(.+?)\s*\(([^)]+)\)$/i);
    if (!unitMatch) continue;

    const unitNumber = unitMatch[1].trim();
    const status = unitMatch[2].trim();
    return {
      allowed: isAllowedPortalStatus(status),
      ...(ledgerId ? { ledgerId } : {}),
      ...(tenantName ? { tenantName } : {}),
      unitNumber,
      status,
    };
  }

  return { allowed: false, error: "unit_status_not_found" };
}

export async function verifyResmanPortalAccess(
  session: ResmanPortalSession,
  fetchImpl: FetchLike = fetch
): Promise<ResmanPortalAccess> {
  if (!isAllowedResmanPortalSession(session)) {
    return { allowed: false, error: "resman_origin_not_allowed" };
  }

  const transactionsPath = process.env.RESMAN_PORTAL_TRANSACTIONS_PATH ?? DEFAULT_TRANSACTIONS_PATH;
  const transactionsUrl = new URL(transactionsPath, session.baseUrl);

  try {
    const response = await fetchImpl(transactionsUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        cookie: session.cookieHeader,
        referer: new URL("/Portal", session.baseUrl).toString(),
      },
    });

    if (!response.ok) {
      return { allowed: false, error: "transactions_unavailable" };
    }

    return parseTransactionsAccess(await response.text());
  } catch (error) {
    console.error("[verifyResmanPortalAccess]", error);
    return { allowed: false, error: "transactions_unavailable" };
  }
}

export async function resmanPortalLogin(
  username: string,
  password: string,
  fetchImpl: FetchLike = fetch
): Promise<ResmanPortalLoginResult> {
  const origin = process.env.RESMAN_PORTAL_ORIGIN ?? DEFAULT_ORIGIN;
  const signInPath = process.env.RESMAN_PORTAL_SIGN_IN_PATH ?? DEFAULT_SIGN_IN_PATH;
  const signInUrl = new URL(signInPath, origin);

  try {
    const signInResponse = await fetchImpl(signInUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (!signInResponse.ok) {
      return { success: false, error: "portal_unavailable", status: signInResponse.status };
    }

    const signInHtml = await signInResponse.text();
    const form = parseSignInForm(signInHtml);
    const initialCookies = getSetCookieHeaders(signInResponse.headers);
    const body = new URLSearchParams(form.fields);
    body.set("Username", username);
    body.set("Password", password);

    const postResponse = await fetchImpl(new URL(form.action, signInUrl), {
      method: "POST",
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "content-type": "application/x-www-form-urlencoded",
        cookie: buildCookieHeader(initialCookies),
        referer: signInUrl.toString(),
      },
      body,
    });

    const postCookies = getSetCookieHeaders(postResponse.headers);
    const sessionCookies = mergeSetCookieHeaders(initialCookies, postCookies);
    const location = postResponse.headers.get("location");

    if (!isSuccessfulResmanLogin(postResponse.status, location)) {
      return {
        success: false,
        error: postResponse.status === 200 ? "invalid_credentials" : "unexpected_response",
        status: postResponse.status,
      };
    }

    const session: ResmanPortalSession = {
      baseUrl: origin,
      signInUrl: signInUrl.toString(),
      cookieHeader: buildCookieHeader(sessionCookies),
      cookies: serializeCookiesForClient(sessionCookies, signInUrl.hostname),
      issuedAt: new Date().toISOString(),
    };
    let tenantName: string | undefined;

    try {
      const portalResponse = await fetchImpl(new URL(location ?? "/Portal", signInUrl), {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          cookie: session.cookieHeader,
          referer: signInUrl.toString(),
        },
      });

      if (portalResponse.ok) {
        tenantName = parseResidentNameFromPortalHtml(await portalResponse.text());
      }
    } catch (error) {
      console.error("[resmanPortalLogin] resident name lookup failed", error);
    }

    return {
      success: true,
      session,
      ...(tenantName ? { tenantName } : {}),
      status: postResponse.status,
    };
  } catch (error) {
    console.error("[resmanPortalLogin]", error);
    return { success: false, error: "portal_unavailable" };
  }
}

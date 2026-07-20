/**
 * Token auth middleware for Emberly Web route handlers.
 *
 * Token format: base64url( JSON payload ) + "." + HMAC-SHA256 signature
 *
 * The payload carries the internal resident id and ResMan ledger id without
 * storing live ResMan session material in the Emberly Web database.
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import {
  ADMIN_KEY_HEADER,
  ADMIN_SESSION_COOKIE,
  GUEST_ENTRY_TOKEN_PREFIX,
  RESIDENT_ENTRY_TOKEN_PREFIX,
  normalizeUnitLabel,
} from "@emberly/core";
import { requestSource } from "./http";
import { checkRateLimit } from "./rate-limit";

const DEFAULT_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SELECTION_MS = 15 * 60 * 1000;
const DEFAULT_ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const DEFAULT_ENTRY_TOKEN_MS = 60 * 1000;
const DEFAULT_GUEST_ENTRY_TOKEN_MS = 10 * 60 * 1000;
const DEFAULT_RESMAN_SESSION_SIGNATURE_MS = 7 * 24 * 60 * 60 * 1000;

export interface TokenPayload {
  /** Discriminator so a resident-entry/guest-entry token can't be replayed as a
   *  30-day resident session if the scoped secrets are ever shared (the dev
   *  fallback, or a misconfig). Optional for backward compatibility with
   *  sessions minted before this field existed. */
  kind?: "resident-session";
  ledgerId?: string;
  residentId?: string;
  unitId?: string;
  unitNumber?: string;
  iat: number;
  exp: number;
}

export interface ResidentSessionSource {
  id: string;
  resman_ledger_id: string;
  name: string;
  unit_id: string;
}

export interface ResidentSession {
  token: string;
  expiresAt: string;
  resident: {
    residentId: string;
    tenantId: string; // resident app reads this field name for the ledger id
    ledgerId: string;
    name: string;
    unitId: string;
    unitNumber: string;
  };
  deviceSession?: ResidentDeviceSession;
}

export interface ResidentDeviceSession {
  deviceId: string;
  token: string;
}

export interface ResidentEntryPayload {
  kind: "resident-entry";
  residentId: string;
  unitNumber: string;
  deviceId?: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface GuestEntryPayload {
  kind: "guest-entry";
  guestPassId: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface ResidentSelectionPayload {
  kind: "resident-selection";
  username: string;
  ledgerId: string;
  residentIds: string[];
  iat: number;
  exp: number;
}

export type AdminRole = "super_admin" | "property_manager" | "security_manager" | "viewer";

export interface AdminAuthContext {
  adminId: string;
  role: AdminRole;
  displayName: string;
}

export interface AdminSessionPayload {
  kind: "admin-session";
  adminId: string;
  role: AdminRole;
  displayName: string;
  iat: number;
  exp: number;
}

export interface ResmanSessionForSigning {
  baseUrl: string;
  signInUrl: string;
  cookieHeader: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
  }>;
  issuedAt: string;
}

export type SignedResmanSession = ResmanSessionForSigning & {
  signature: string;
};

function getRequiredSecret(envNames: string[], label: string): string {
  for (const envName of envNames) {
    const value = process.env[envName]?.trim();
    if (value) return value;
  }

  throw new Error(`${label} secret is not configured`);
}

function getScopedSecret(primaryEnvName: string, fallbackEnvNames: string[], label: string): string {
  if (process.env.NODE_ENV === "production") {
    const value = process.env[primaryEnvName]?.trim();
    if (value) return value;
    throw new Error(`${label} secret is not configured; set ${primaryEnvName}`);
  }

  return getRequiredSecret([primaryEnvName, ...fallbackEnvNames], label);
}

function getResidentSessionSecret(): string {
  return getScopedSecret("RESIDENT_SESSION_SECRET", ["API_SECRET_KEY"], "Resident session");
}

function getResidentSelectionSecret(): string {
  return getScopedSecret(
    "SELECTION_TOKEN_SECRET",
    ["RESIDENT_SESSION_SECRET", "API_SECRET_KEY"],
    "Resident selection"
  );
}

function getResidentEntrySecret(): string {
  return getScopedSecret(
    "RESIDENT_ENTRY_TOKEN_SECRET",
    ["RESIDENT_SESSION_SECRET", "API_SECRET_KEY"],
    "Resident entry token"
  );
}

function getGuestEntrySecret(): string {
  return getScopedSecret(
    "GUEST_ENTRY_TOKEN_SECRET",
    ["RESIDENT_ENTRY_TOKEN_SECRET", "RESIDENT_SESSION_SECRET", "API_SECRET_KEY"],
    "Guest entry token"
  );
}

function getAdminSessionSecret(): string {
  return getScopedSecret("ADMIN_SESSION_SECRET", ["API_SECRET_KEY"], "Admin session");
}

/**
 * Emergency break-glass secret. Off by default — returns null unless
 * ADMIN_BREAKGLASS_KEY is explicitly set, so there is no standing shared admin
 * key. When set, it is the only non-ResMan way into the admin dashboard.
 */
function breakGlassSecret(): string | null {
  return process.env.ADMIN_BREAKGLASS_KEY?.trim() || null;
}

function getResmanSessionSecret(): string {
  return getScopedSecret(
    "RESMAN_SESSION_SIGNING_SECRET",
    ["RESIDENT_SESSION_SECRET", "API_SECRET_KEY"],
    "ResMan session signing"
  );
}

function getResmanSessionSignatureMaxAgeMs(): number {
  const configured = process.env.RESMAN_SESSION_SIGNATURE_MAX_AGE_MS?.trim();
  if (!configured) return DEFAULT_RESMAN_SESSION_SIGNATURE_MS;

  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESMAN_SESSION_SIGNATURE_MS;
}

export function secureCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createSignedPayload(payload: object, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

function canonicalResmanSessionPayload(session: ResmanSessionForSigning): string {
  return JSON.stringify({
    baseUrl: session.baseUrl,
    signInUrl: session.signInUrl,
    cookieHeader: session.cookieHeader,
    cookies: session.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    })),
    issuedAt: session.issuedAt,
  });
}

export function createSignedResmanPortalSession(
  session: ResmanSessionForSigning
): SignedResmanSession {
  const payload = canonicalResmanSessionPayload(session);
  return {
    ...session,
    signature: sign(payload, getResmanSessionSecret()),
  };
}

export function verifySignedResmanPortalSession(
  session: SignedResmanSession,
  now = Date.now(),
  maxAgeMs = getResmanSessionSignatureMaxAgeMs()
): ResmanSessionForSigning | null {
  try {
    const { signature, ...unsignedSession } = session;
    if (!signature) return null;
    const expected = sign(canonicalResmanSessionPayload(unsignedSession), getResmanSessionSecret());
    if (!secureCompare(expected, signature)) return null;
    const issuedAtMs = Date.parse(unsignedSession.issuedAt);
    if (!Number.isFinite(issuedAtMs)) return null;
    if (issuedAtMs > now + 5 * 60 * 1000) return null;
    if (now - issuedAtMs > maxAgeMs) return null;
    return unsignedSession;
  } catch {
    return null;
  }
}

function readSignedPayload<T>(token: string, secret: string): T | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!secureCompare(sign(payload, secret), sig)) return null;

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as T;
}

export function inferUnitNumber(unitId: string, unitAddress = ""): string {
  const normalizedUnitId = normalizeUnitLabel(unitId);
  if (normalizedUnitId) return normalizedUnitId;

  const match = unitAddress.match(/\b(?:unit|apt|apartment|#)\s*([A-Za-z0-9-]+)/i);
  return normalizeUnitLabel(match?.[1] ?? unitAddress);
}

export function createResidentSession(
  resident: ResidentSessionSource,
  options: { now?: number; ttlMs?: number } = {}
): ResidentSession {
  const now = options.now ?? Date.now();
  const expiresAtMs = now + (options.ttlMs ?? DEFAULT_SESSION_MS);
  const unitNumber = inferUnitNumber(resident.unit_id);

  const tokenPayload: TokenPayload = {
    kind: "resident-session",
    ledgerId: resident.resman_ledger_id,
    residentId: resident.id,
    unitId: resident.unit_id,
    unitNumber,
    iat: now,
    exp: expiresAtMs,
  };

  return {
    token: createSignedPayload(tokenPayload, getResidentSessionSecret()),
    expiresAt: new Date(expiresAtMs).toISOString(),
    resident: {
      residentId: resident.id,
      tenantId: resident.resman_ledger_id,
      ledgerId: resident.resman_ledger_id,
      name: resident.name,
      unitId: resident.unit_id,
      unitNumber,
    },
  };
}

export function createResidentEntryToken(
  input: {
    residentId: string;
    unitNumber: string;
    deviceId?: string | null;
  },
  options: { now?: number; ttlMs?: number; jti?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const payload: ResidentEntryPayload = {
    kind: "resident-entry",
    residentId: input.residentId,
    unitNumber: input.unitNumber,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    jti: options.jti ?? randomUUID(),
    iat: now,
    exp: now + (options.ttlMs ?? DEFAULT_ENTRY_TOKEN_MS),
  };

  return `${RESIDENT_ENTRY_TOKEN_PREFIX}${createSignedPayload(payload, getResidentEntrySecret())}`;
}

export function verifyResidentEntryToken(
  token: string,
  now = Date.now()
): ResidentEntryPayload | null {
  try {
    const rawToken = token.startsWith(RESIDENT_ENTRY_TOKEN_PREFIX)
      ? token.slice(RESIDENT_ENTRY_TOKEN_PREFIX.length)
      : token;
    const decoded = readSignedPayload<ResidentEntryPayload>(rawToken, getResidentEntrySecret());
    if (!decoded || decoded.kind !== "resident-entry") return null;
    if (now > decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function createGuestEntryToken(
  input: { guestPassId: string },
  options: { now?: number; ttlMs?: number; jti?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const payload: GuestEntryPayload = {
    kind: "guest-entry",
    guestPassId: input.guestPassId,
    jti: options.jti ?? randomUUID(),
    iat: now,
    exp: now + (options.ttlMs ?? DEFAULT_GUEST_ENTRY_TOKEN_MS),
  };

  return `${GUEST_ENTRY_TOKEN_PREFIX}${createSignedPayload(payload, getGuestEntrySecret())}`;
}

export function verifyGuestEntryToken(token: string, now = Date.now()): GuestEntryPayload | null {
  try {
    const rawToken = token.startsWith(GUEST_ENTRY_TOKEN_PREFIX)
      ? token.slice(GUEST_ENTRY_TOKEN_PREFIX.length)
      : token;
    const decoded = readSignedPayload<GuestEntryPayload>(rawToken, getGuestEntrySecret());
    if (!decoded || decoded.kind !== "guest-entry") return null;
    if (now > decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function createResidentSelectionToken(
  input: { username: string; ledgerId: string; residentIds: string[] },
  options: { now?: number; ttlMs?: number } = {}
): string {
  const now = options.now ?? Date.now();
  return createSignedPayload({
    kind: "resident-selection",
    username: input.username,
    ledgerId: input.ledgerId,
    residentIds: input.residentIds,
    iat: now,
    exp: now + (options.ttlMs ?? DEFAULT_SELECTION_MS),
  } satisfies ResidentSelectionPayload, getResidentSelectionSecret());
}

export function verifyResidentSelectionToken(
  token: string,
  residentId: string,
  now = Date.now()
): ResidentSelectionPayload | null {
  try {
    const decoded = readSignedPayload<ResidentSelectionPayload>(token, getResidentSelectionSecret());
    if (!decoded || decoded.kind !== "resident-selection") return null;
    if (now > decoded.exp) return null;
    if (!decoded.residentIds.includes(residentId)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function verifyToken(token: string, now = Date.now()): TokenPayload | null {
  try {
    const decoded = readSignedPayload<TokenPayload>(token, getResidentSessionSecret());
    if (!decoded?.exp) return null;
    if (now > decoded.exp) return null;
    // Reject a token explicitly stamped as another kind (e.g. resident-entry).
    // Legacy sessions predate `kind` and carry none, so they still pass. Read the
    // raw value — the decoded payload may hold a kind outside TokenPayload's type.
    const kind = (decoded as { kind?: string }).kind;
    if (kind && kind !== "resident-session") return null;

    return decoded;
  } catch {
    return null;
  }
}

export function verifyRequest(request: Request): TokenPayload | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return verifyToken(authHeader.slice(7));
}

export const BOOTSTRAP_ADMIN_CONTEXT: AdminAuthContext = {
  adminId: "bootstrap-admin",
  role: "super_admin",
  displayName: "Bootstrap Admin",
};

export function createAdminSessionToken(
  options: { now?: number; ttlMs?: number } & Partial<AdminAuthContext> = {}
): string {
  const now = options.now ?? Date.now();
  const admin: AdminAuthContext = {
    adminId: options.adminId ?? BOOTSTRAP_ADMIN_CONTEXT.adminId,
    role: options.role ?? BOOTSTRAP_ADMIN_CONTEXT.role,
    displayName: options.displayName ?? BOOTSTRAP_ADMIN_CONTEXT.displayName,
  };

  return createSignedPayload(
    {
      kind: "admin-session",
      ...admin,
      iat: now,
      exp: now + (options.ttlMs ?? DEFAULT_ADMIN_SESSION_MS),
    } satisfies AdminSessionPayload,
    getAdminSessionSecret()
  );
}

export function readAdminSessionToken(token: string, now = Date.now()): AdminAuthContext | null {
  try {
    const decoded = readSignedPayload<AdminSessionPayload>(token, getAdminSessionSecret());
    if (!decoded || decoded.kind !== "admin-session" || now > decoded.exp) return null;
    if (!decoded.adminId || !decoded.role || !decoded.displayName) return null;
    return {
      adminId: decoded.adminId,
      role: decoded.role,
      displayName: decoded.displayName,
    };
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

  return value ? decodeURIComponent(value) : null;
}

/** True only when the break-glass key is configured and matches. */
export function verifyBreakGlassKey(key: string): boolean {
  const secret = breakGlassSecret();
  if (!secret) return false;
  try {
    return secureCompare(key, secret);
  } catch {
    return false;
  }
}

export async function verifyAdminKey(request: Request): Promise<boolean> {
  return !!(await verifyAdminRequest(request));
}

export async function verifyAdminRequest(
  request: Request,
  now = Date.now()
): Promise<AdminAuthContext | null> {
  const headerKey = request.headers.get(ADMIN_KEY_HEADER);
  if (headerKey) {
    // Valid keys are accepted immediately so successful callers are never
    // throttled; only failed header-key attempts consume the rate limit.
    if (verifyBreakGlassKey(headerKey)) return BOOTSTRAP_ADMIN_CONTEXT;

    const allowed = await checkRateLimit({
      bucket: `admin-key:${requestSource(request)}`,
      maxAttempts: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!allowed) return null;
  }

  const sessionCookie = readCookie(request, ADMIN_SESSION_COOKIE);
  return sessionCookie ? readAdminSessionToken(sessionCookie, now) : null;
}

export function adminHasRole(
  admin: AdminAuthContext,
  allowedRoles: AdminRole[]
): boolean {
  return admin.role === "super_admin" || allowedRoles.includes(admin.role);
}

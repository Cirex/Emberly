/**
 * Scanner authentication.
 *
 * The `scanner_devices` registry is the SOLE source of scanner keys — there are
 * no env-configured keys (the SCANNER_KEYS map and the SCANNER_API_KEY shared
 * fallback are retired). Every device must be provisioned from the admin
 * Scanners page, which is also the only way to rotate or revoke one.
 *
 * The stored `secret_hash` is a deterministic HMAC (no per-row salt), so a key
 * self-identifies: hash it and look the device up directly, the same model the
 * access_tokens use with `token_hash`.
 */
import { createHmac, randomBytes } from "crypto";
import { SCANNER_KEY_HEADER } from "@emberly/core";
import { secureCompare } from "./auth";
import { MemoryRateLimiter } from "./memory-rate-limit";
import { type ScannerRegistryClient } from "./scanner-devices";

type ScannerAuthClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{
          data: { scanner_id: string; enabled: boolean; secret_hash: string | null } | null;
          error: unknown;
        }>;
      };
    };
  };
};

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 60;
const HMAC_HASH_PREFIX = "hmac-sha256:";

/**
 * Keys are `${scannerId}:${type}:${token.slice(-24)}` and resident entry
 * tokens live 60 seconds, so nearly every scan produces a key that is never
 * seen again. Bounded and swept — see lib/memory-rate-limit.ts.
 */
const attempts = new MemoryRateLimiter();

export function createScannerSecret(): string {
  return randomBytes(32).toString("base64url");
}

function scannerSecretPepper(): string {
  return process.env.SCANNER_SECRET_PEPPER
    || process.env.ADMIN_SESSION_SECRET
    || process.env.API_SECRET_KEY
    || "emberly-scanner-secret-development-pepper";
}

export function hashScannerSecret(secret: string): string {
  return `${HMAC_HASH_PREFIX}${createHmac("sha256", scannerSecretPepper()).update(secret).digest("hex")}`;
}

export function verifyScannerSecretHash(secret: string, expectedHash: string): boolean {
  if (!expectedHash.startsWith(HMAC_HASH_PREFIX)) return false;
  return secureCompare(hashScannerSecret(secret), expectedHash);
}

function providedScannerSecret(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  return bearer || request.headers.get(SCANNER_KEY_HEADER);
}

/** True when the request carries a scanner credential (Bearer or x-scanner-key). */
export function hasScannerCredential(request: Request): boolean {
  return providedScannerSecret(request) !== null;
}

/**
 * Registry-backed scanner auth — the only way a scanner authenticates.
 *
 * When the device does not supply an id the key self-identifies: hash it and
 * look the device up by `secret_hash` directly. Passing `requestedScannerId`
 * still works, for devices provisioned before the key became self-identifying.
 * A row must exist and be `enabled`.
 */
export async function getAuthenticatedScannerFromDatabase(
  supabase: ScannerAuthClient,
  request: Request,
  requestedScannerId?: string | null
): Promise<{ scannerId: string } | null> {
  const provided = providedScannerSecret(request);
  if (!provided) return null;

  if (requestedScannerId) {
    const { data: scanner, error } = await supabase
      .from("scanner_devices")
      .select("scanner_id, enabled, secret_hash")
      .eq("scanner_id", requestedScannerId)
      .maybeSingle();

    if (error || !scanner?.enabled || !scanner.secret_hash) return null;
    return verifyScannerSecretHash(provided, scanner.secret_hash)
      ? { scannerId: requestedScannerId }
      : null;
  }

  const { data: scanner, error } = await supabase
    .from("scanner_devices")
    .select("scanner_id, enabled, secret_hash")
    .eq("secret_hash", hashScannerSecret(provided))
    .maybeSingle();

  if (error || !scanner?.enabled) return null;
  return { scannerId: scanner.scanner_id };
}

export type AuthenticatedScanner = {
  scannerId: string;
};

/**
 * Authenticates a scanner request against the scanner_devices registry — the
 * sole source of scanner keys.
 */
export async function authenticateScanner(
  request: Request,
  requestedScannerId: string | null | undefined,
  supabase: ScannerAuthClient
): Promise<AuthenticatedScanner | null> {
  return getAuthenticatedScannerFromDatabase(supabase, request, requestedScannerId);
}

/**
 * Refreshes the scanner's `last_seen_at` heartbeat. Authentication already
 * loaded the row and confirmed it is enabled (the registry is the only auth
 * path), so this never re-checks the registry — it is a pure side-effect and
 * returns nothing. (It used to return a constant `true` that a caller checked,
 * which read as a live "is it enabled?" gate but could never be false.)
 */
export async function touchScannerLastSeen(
  supabase: ScannerRegistryClient,
  scanner: AuthenticatedScanner,
  now = new Date().toISOString()
): Promise<void> {
  await supabase
    .from("scanner_devices")
    .update({ last_seen_at: now })
    .eq("scanner_id", scanner.scannerId);
}

export function rateLimitScannerAttempt(key: string, now = Date.now()): boolean {
  return attempts.check(key, MAX_ATTEMPTS, WINDOW_MS, now);
}

/** Live key count, for the leak regression test. */
export function scannerRateLimitSize(): number {
  return attempts.size;
}

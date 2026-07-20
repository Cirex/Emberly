import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

export const MAP_ANNOTATIONS_FEATURE_KEY = "property_map.annotations" as const;

export type MapSyncFeatureKey = typeof MAP_ANNOTATIONS_FEATURE_KEY;
export type MapSyncCapability = "read" | "create" | "update" | "delete";
export type MapSyncCapabilities = Partial<Record<MapSyncCapability, boolean>>;
export type MapSyncKeyContext = {
  id: string;
  resman_account_id: string;
  property_id: string;
  property_name: string;
  feature_key: string;
  capabilities: MapSyncCapabilities;
  requester_display_name: string | null;
  requester_resman_login_hash: string | null;
  device_id: string;
};

const HASH_PREFIX = "sha256:";
const HMAC_HASH_PREFIX = "hmac-sha256:";
const SECRET_BYTES = 32;

function createUrlSafeSecret(prefix: string): string {
  return `${prefix}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export function createSyncKeySecret(): string {
  return createUrlSafeSecret("emsync_");
}

export function createClaimToken(): string {
  return createUrlSafeSecret("emclaim_");
}

export function hashSecret(secret: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(secret).digest("hex")}`;
}

export function verifySecretHash(secret: string, expectedHash: string | null | undefined): boolean {
  if (!expectedHash?.startsWith(HASH_PREFIX)) return false;

  const actual = Buffer.from(hashSecret(secret));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashRequesterLogin(login?: string | null): string | null {
  const normalized = login?.trim().toLowerCase();
  if (!normalized) return null;

  return `${HMAC_HASH_PREFIX}${createHmac("sha256", requesterLoginHashSecret())
    .update(`resman-login:${normalized}`)
    .digest("hex")}`;
}

function requesterLoginHashSecret(): string {
  const configured = process.env.MAP_SYNC_HASH_SECRET?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error("Map sync hash secret is not configured; set MAP_SYNC_HASH_SECRET");
  }

  return process.env.ADMIN_SESSION_SECRET?.trim()
    || process.env.API_SECRET_KEY?.trim()
    || "emberly-map-sync-development-pepper";
}

export function buildSyncCapabilities(
  capabilities: MapSyncCapabilities = {},
): Record<MapSyncCapability, boolean> {
  return {
    read: capabilities.read ?? true,
    create: capabilities.create ?? true,
    update: capabilities.update ?? true,
    delete: capabilities.delete ?? true,
  };
}

export function isCapabilityAllowed(
  capabilities: MapSyncCapabilities | null | undefined,
  capability: MapSyncCapability,
): boolean {
  return capabilities?.[capability] === true;
}

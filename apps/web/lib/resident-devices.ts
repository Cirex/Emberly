import { createHash, randomBytes, timingSafeEqual } from "crypto";

type DeviceClient = {
  from: (table: string) => any;
};

const DEFAULT_DEVICE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export type ResidentDeviceSession = {
  deviceId: string;
  token: string;
  expiresAt: string;
};

export class ResidentDeviceSessionError extends Error {
  supabaseError?: unknown;

  constructor(message: string, supabaseError?: unknown) {
    super(message);
    this.name = "ResidentDeviceSessionError";
    this.supabaseError = supabaseError;
  }
}

function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function verifyDeviceTokenHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashDeviceToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createResidentDeviceSession(
  supabase: DeviceClient,
  input: {
    residentId: string;
    userAgent?: string | null;
    now?: number;
    ttlMs?: number;
  }
): Promise<ResidentDeviceSession> {
  const now = input.now ?? Date.now();
  const expiresAt = new Date(now + (input.ttlMs ?? DEFAULT_DEVICE_SESSION_MS)).toISOString();
  const token = randomBytes(32).toString("base64url");
  const { data, error } = await supabase
    .from("resident_devices")
    .insert({
      resident_id: input.residentId,
      token_hash: hashDeviceToken(token),
      user_agent: input.userAgent ?? null,
      active: true,
      expires_at: expiresAt,
      last_seen_at: new Date(now).toISOString(),
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new ResidentDeviceSessionError("Failed to create resident device session", error);
  }

  return { deviceId: data.id, token, expiresAt };
}

export async function verifyResidentDeviceSession(
  supabase: DeviceClient,
  input: {
    residentId: string;
    deviceToken: string;
    now?: number;
  }
): Promise<{ valid: true; deviceId: string } | { valid: false }> {
  const now = input.now ?? Date.now();
  const tokenHash = hashDeviceToken(input.deviceToken);
  const { data, error } = await supabase
    .from("resident_devices")
    .select("id, token_hash, active, expires_at")
    .eq("resident_id", input.residentId)
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (
    error ||
    !data?.active ||
    !data.expires_at ||
    now > Date.parse(data.expires_at) ||
    !verifyDeviceTokenHash(input.deviceToken, data.token_hash)
  ) {
    return { valid: false };
  }

  await supabase
    .from("resident_devices")
    .update({ last_seen_at: new Date(now).toISOString() })
    .eq("id", data.id);

  return { valid: true, deviceId: data.id };
}

export async function revokeResidentDeviceSessions(
  supabase: DeviceClient,
  residentId: string
): Promise<void> {
  const { error } = await supabase
    .from("resident_devices")
    .update({ active: false })
    .eq("resident_id", residentId);

  if (error) {
    throw new Error("Failed to revoke resident device sessions");
  }
}

import { NextResponse } from "next/server";
import {
  MAP_ANNOTATIONS_FEATURE_KEY,
  hashSecret,
  isCapabilityAllowed,
  type MapSyncCapability,
  type MapSyncKeyContext,
} from "./map-sync";
import type { UntypedSupabase } from "./supabase/types";

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function requestDeviceId(request: Request): string | null {
  return request.headers.get("X-Device-ID")?.trim() || null;
}

/**
 * Authenticates a map sync-key request: validates the bearer sync key, binds
 * it to the requesting device and property/feature, checks the requested
 * capability, and records key usage.
 */
export async function authenticateMapSyncRequest(
  request: Request,
  propertyId: string,
  capability: MapSyncCapability,
  supabase: UntypedSupabase,
): Promise<
  | { ok: true; syncKey: MapSyncKeyContext }
  | { ok: false; response: NextResponse }
> {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const keyHash = hashSecret(token);
  const { data: syncKey, error } = await supabase
    .from("map_sync_keys")
    .select("id, resman_account_id, property_id, property_name, feature_key, capabilities, requester_display_name, requester_resman_login_hash, device_id")
    .eq("key_hash", keyHash)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    console.error("[map/annotations auth] Sync key load error:", error);
    return { ok: false, response: NextResponse.json({ error: "Failed to load sync key" }, { status: 500 }) };
  }
  if (!syncKey) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const deviceId = requestDeviceId(request);
  if (!deviceId) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (syncKey.device_id !== deviceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden", reason: "device_mismatch" },
        { status: 403 },
      ),
    };
  }
  if (syncKey.property_id !== propertyId || syncKey.feature_key !== MAP_ANNOTATIONS_FEATURE_KEY) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (!isCapabilityAllowed(syncKey.capabilities, capability)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  const { error: lastUsedError } = await supabase
    .from("map_sync_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", syncKey.id);

  if (lastUsedError) {
    console.error("[map/annotations auth] Last-used update error:", lastUsedError, { syncKeyId: syncKey.id });
  }

  return { ok: true, syncKey };
}

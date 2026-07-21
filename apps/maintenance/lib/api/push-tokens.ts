import { z } from "zod";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Device-side client for the emergency-push token registry. The server keeps
 * one row per Expo push token; registering is an upsert and deleting is
 * idempotent, so both calls are safe to repeat.
 */

const OkSchema = z.object({ ok: z.literal(true) });

/** Injectable for tests — the app always passes the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PushPlatform = "ios" | "android";

const BASE = "/api/admin/push-tokens";

function headers(config: StaffConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
}

/** POST the Expo push token; true only when the server acknowledged it. */
export async function registerPushToken(
  input: { token: string; platform: PushPlatform },
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${config.baseUrl}${BASE}`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ token: input.token, platform: input.platform }),
    });
    if (!res.ok) return false;
    return OkSchema.safeParse(await res.json()).success;
  } catch {
    return false;
  }
}

/** DELETE the Expo push token; idempotent server-side. */
export async function unregisterPushToken(
  input: { token: string },
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${config.baseUrl}${BASE}`, {
      method: "DELETE",
      headers: headers(config),
      body: JSON.stringify({ token: input.token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

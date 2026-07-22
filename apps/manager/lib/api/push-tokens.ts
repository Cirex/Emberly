import { z } from "zod";
import type { ManagerAlertKind } from "@/lib/push-routing";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Device-side client for the staff push-token registry (shared with the
 * maintenance app — same route, same table). The server keeps one row per Expo
 * push token; registering is an upsert and deleting is idempotent, so both
 * calls are safe to repeat.
 *
 * `app: "manager"` is what scopes the row to this fleet: the sync worker's
 * manager-alerts job only reads `app = 'manager'` rows and the emergency
 * work-order job only reads `app = 'maintenance'` rows. Sending the wrong
 * value would push manager alerts to maintenance phones.
 *
 * `alertKinds` carries the settings screen's per-kind toggles so the SERVER
 * can filter. Doing it client-side would not work: a push arriving while the
 * app is backgrounded is presented by the OS before any of our code runs.
 */

const OkSchema = z.object({ ok: z.literal(true) });

/** Injectable for tests — the app always passes the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PushPlatform = "ios" | "android";

/** This app's push_tokens.app value. */
export const PUSH_TOKEN_APP = "manager";

const BASE = "/api/admin/push-tokens";

function headers(config: StaffConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
}

export interface RegisterPushTokenInput {
  token: string;
  platform: PushPlatform;
  /** Kinds this device has switched on; never empty (all-off unregisters). */
  alertKinds: readonly ManagerAlertKind[];
}

/** POST the Expo push token; true only when the server acknowledged it. */
export async function registerPushToken(
  input: RegisterPushTokenInput,
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${config.baseUrl}${BASE}`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        token: input.token,
        platform: input.platform,
        app: PUSH_TOKEN_APP,
        alertKinds: [...input.alertKinds],
      }),
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

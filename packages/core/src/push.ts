/**
 * Expo push TRANSPORT — message shapes, chunking, and the send itself.
 *
 * Lives in core because two packages now need it and a hand-rolled second copy
 * of a network protocol is how the two drift: the sync worker sends emergency
 * work-order and manager alerts, and the web app sends monitor findings. What
 * a message MEANS stays with whoever sends it; only the wire format is here.
 *
 * No Supabase, no environment, `fetch` injectable — so every path is testable
 * without network, and the caller owns token reads/writes and must treat the
 * whole send as best-effort. A push failure must never fail the job behind it.
 */

/** Expo push API endpoint (JSON array of messages, ≤100 per request). */
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Max messages per Expo push request. */
export const EXPO_PUSH_CHUNK = 100;

/**
 * The `data` blob Expo hands back to the device on tap. Deliberately a loose
 * record: each sender carries its own shape (`{ workOrderId, unitNumber }`,
 * `{ route, kind, id }`, …) and they all go through the one sender below.
 */
export type ExpoPushData = Record<string, string | number | boolean | null>;

/** A visible alert: title, body, lock screen. */
export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  priority: "high";
  data: ExpoPushData;
}

/**
 * A SILENT push: no title, no body, no sound, so the OS hands it straight to
 * the app instead of the lock screen.
 *
 * `_contentAvailable` is Expo's spelling of the APNs `content-available: 1`
 * flag; without it iOS drops a message carrying no user-visible content.
 * Priority stays "normal": these are not alerts, and "high" on a silent push is
 * how an app earns itself a delivery-rate throttle from Apple.
 */
export interface ExpoDataPushMessage {
  to: string;
  data: ExpoPushData;
  _contentAvailable: true;
  priority: "normal";
}

/** Either shape the sender accepts. */
export type ExpoAnyPushMessage = ExpoPushMessage | ExpoDataPushMessage;

/** Split messages into Expo-sized request chunks. */
export function chunkPushMessages<T>(items: ReadonlyArray<T>, size = EXPO_PUSH_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SendExpoPushResult {
  /** Messages accepted by the Expo API (ticket status "ok"). */
  sent: number;
  /** Messages Expo rejected or that never reached the API. */
  failed: number;
  /** Tokens Expo reported as DeviceNotRegistered — deactivate these rows. */
  invalidTokens: string[];
}

/**
 * POST the messages to the Expo push API in chunks. Never throws: transport
 * errors, non-2xx responses, and malformed bodies are counted as failures and
 * logged. Tickets come back in message order per request, so an error ticket
 * with `details.error === "DeviceNotRegistered"` maps back to its message's
 * token for deactivation.
 */
export async function sendExpoPushMessages(
  messages: ReadonlyArray<ExpoAnyPushMessage>,
  deps: { fetchFn?: FetchLike; log?: (message: string) => void } = {},
): Promise<SendExpoPushResult> {
  // Reached through globalThis rather than the bare identifier: core is shared
  // with React Native and does not compile against the DOM lib, so `fetch` is
  // not a declared global here even though every runtime that calls this has
  // one. Absent, the send fails as a counted failure — never a throw, because
  // the caller treats push as best-effort.
  const log = deps.log ?? (() => {});
  const fetchFn = deps.fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
  const result: SendExpoPushResult = { sent: 0, failed: 0, invalidTokens: [] };
  if (!fetchFn) {
    log("[push] no fetch implementation available; nothing sent");
    return { sent: 0, failed: messages.length, invalidTokens: [] };
  }

  for (const chunk of chunkPushMessages(messages)) {
    try {
      const response = await fetchFn(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(chunk),
      });
      if (!response.ok) {
        result.failed += chunk.length;
        log(`[push] Expo push request failed with status ${response.status}`);
        continue;
      }
      const body = (await response.json()) as { data?: unknown } | null;
      const tickets = Array.isArray(body?.data) ? (body.data as Array<Record<string, unknown>>) : [];
      for (let i = 0; i < chunk.length; i += 1) {
        const ticket = tickets[i];
        if (ticket?.status === "ok") {
          result.sent += 1;
          continue;
        }
        result.failed += 1;
        const details = ticket?.details as { error?: unknown } | undefined;
        if (details?.error === "DeviceNotRegistered") {
          result.invalidTokens.push(chunk[i].to);
        }
      }
    } catch (error) {
      result.failed += chunk.length;
      log(`[push] Expo push request threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

/**
 * Expo push send for emergency work-order alerts — pure logic, no Supabase.
 *
 * The work-orders job detects freshly-inserted Emergency work orders in an
 * open status (detectNewEmergencies), builds one message per registered
 * device (buildEmergencyPushMessages), and posts them to the Expo push API
 * in chunks of 100 (sendExpoPushMessages). `fetch` is injectable so every
 * path is unit-testable without network; the caller owns the push_tokens
 * reads/writes and must treat the whole send as best-effort — a push
 * failure never fails the sync job.
 */

/** Expo push API endpoint (JSON array of messages, ≤100 per request). */
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Max messages per Expo push request. */
export const EXPO_PUSH_CHUNK = 100;

const TITLE_TRUNCATE = 120;

/**
 * Statuses that count as "open" for alerting. The mirror's CHECK set folds
 * ResMan's "Submitted"/"On Hold"/"Open" into other values today, but the raw
 * report labels are included so a future CHECK widening keeps alerting.
 */
export const OPEN_WORK_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "Open",
  "In Progress",
  "Not Started",
  "On Hold",
  "Submitted",
  "Scheduled",
]);

export interface EmergencyWorkOrder {
  workOrderId: string;
  unitNumber: string;
  title: string;
}

/**
 * The `data` blob Expo hands back to the device on tap. Deliberately a loose
 * record: the maintenance app's emergency pushes carry
 * `{ workOrderId, unitNumber }` while the manager app's alerts carry
 * `{ route, kind, id }` (manager/alerts.ts), and both go through the one
 * sender below.
 */
export type ExpoPushData = Record<string, string | number | boolean | null>;

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
 * the app instead of the lock screen. Its only job is to tell a device that the
 * server has something new, so the app can run the sync tick it already has
 * — which is what turns a 60-second poll into "updates when the data updates"
 * without the phone holding a socket open.
 *
 * `_contentAvailable` is Expo's spelling of the APNs `content-available: 1`
 * flag; without it iOS drops a message that carries no user-visible content.
 * Priority stays "normal": these are not alerts, and "high" on a silent push is
 * how an app earns itself a delivery-rate throttle from Apple.
 */
export interface ExpoDataPushMessage {
  to: string;
  data: ExpoPushData;
  _contentAvailable: true;
  priority: "normal";
}

/** Either shape the Expo sender accepts. */
export type ExpoAnyPushMessage = ExpoPushMessage | ExpoDataPushMessage;

/**
 * Newly-inserted Emergency work orders in an open status: rows whose id was
 * absent from the mirror before the upsert, priority === "Emergency", and
 * status in OPEN_WORK_ORDER_STATUSES. Rows are the mapped upsert payloads
 * (mapWorkOrderRow output).
 */
export function detectNewEmergencies(
  existingIds: ReadonlySet<string>,
  rows: ReadonlyArray<Record<string, unknown>>,
): EmergencyWorkOrder[] {
  const out: EmergencyWorkOrder[] = [];
  for (const row of rows) {
    const id = String(row.resman_work_order_id ?? "");
    if (id.length === 0 || existingIds.has(id)) continue;
    if (row.priority !== "Emergency") continue;
    if (!OPEN_WORK_ORDER_STATUSES.has(String(row.status ?? ""))) continue;
    out.push({
      workOrderId: id,
      unitNumber: String(row.unit_number ?? ""),
      title: String(row.title ?? ""),
    });
  }
  return out;
}

/** One message per device token: "Emergency work order" / "<unit> · <title>". */
export function buildEmergencyPushMessages(
  workOrder: EmergencyWorkOrder,
  tokens: ReadonlyArray<string>,
): ExpoPushMessage[] {
  const title = workOrder.title.length > TITLE_TRUNCATE
    ? `${workOrder.title.slice(0, TITLE_TRUNCATE)}…`
    : workOrder.title;
  return tokens.map((to) => ({
    to,
    title: "Emergency work order",
    body: `${workOrder.unitNumber} · ${title}`,
    sound: "default",
    priority: "high",
    data: { workOrderId: workOrder.workOrderId, unitNumber: workOrder.unitNumber },
  }));
}

/**
 * ONE silent wake-up per device — deliberately not one per changed work order.
 * A big ResMan edit pass can move dozens of rows; the device's answer to all of
 * them is the same single sync tick, so fanning out per row would just spend the
 * app's push budget to do the same work N times.
 *
 * `changed` rides along for logging and for the app to decide whether a tick is
 * worth it at all; the device must NOT trust it as data.
 */
export function buildWorkOrdersChangedMessages(
  tokens: ReadonlyArray<string>,
  changed: number,
): ExpoDataPushMessage[] {
  return tokens.map((to) => ({
    to,
    data: { type: "work-orders-changed", changed },
    _contentAvailable: true,
    priority: "normal",
  }));
}

/** Split messages into Expo-sized request chunks. */
export function chunkPushMessages<T>(items: ReadonlyArray<T>, size = EXPO_PUSH_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

type FetchLike = (
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
  const fetchFn = deps.fetchFn ?? (fetch as unknown as FetchLike);
  const log = deps.log ?? (() => {});
  const result: SendExpoPushResult = { sent: 0, failed: 0, invalidTokens: [] };

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

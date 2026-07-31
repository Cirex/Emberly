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

import {
  chunkPushMessages,
  EXPO_PUSH_CHUNK,
  EXPO_PUSH_URL,
  sendExpoPushMessages,
  type ExpoAnyPushMessage,
  type ExpoDataPushMessage,
  type ExpoPushData,
  type ExpoPushMessage,
  type SendExpoPushResult,
} from "@emberly/core";

// The wire format and the send itself now live in @emberly/core, because the
// web app sends monitor findings through the same API and a second hand-rolled
// copy of a network protocol is how the two drift. Re-exported here so every
// existing import of this module keeps working unchanged.
export {
  chunkPushMessages,
  EXPO_PUSH_CHUNK,
  EXPO_PUSH_URL,
  sendExpoPushMessages,
  type ExpoAnyPushMessage,
  type ExpoDataPushMessage,
  type ExpoPushData,
  type ExpoPushMessage,
  type SendExpoPushResult,
};

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


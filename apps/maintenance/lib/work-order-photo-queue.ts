import type {
  WorkOrderPhotoPhase,
  WorkOrderPhotoUploadOutcome,
} from "@/lib/api/work-order-photos";

/**
 * Pure queue transitions for the completion-photo upload queue — the decision
 * logic behind lib/stores/work-order-photos.ts, kept free of React Native and
 * Expo imports so it unit-tests under bun like the other lib modules.
 *
 * Lifecycle of an entry: enqueued at close time → uploaded on a sync tick
 * (dropped, local file deleted) — or dropped when the local file vanished, the
 * server rejected it outright, the retry budget ran out, or it went stale.
 */

export interface PendingWorkOrderPhoto {
  /** Local photo id; the JPEG lives at Documents/work-order-photos/{id}.jpg. */
  photoId: string;
  /** resman_work_order_id the photo attaches to. */
  workOrderId: string;
  phase: WorkOrderPhotoPhase;
  queuedAt: number;
  /** Server-answered attempts (offline tries don't count — see settlePhoto). */
  attempts: number;
}

export type WorkOrderPhotoQueue = Record<string, PendingWorkOrderPhoto>;

/** Mirrors the pending-closes stale window: a photo this old stops retrying. */
export const PHOTO_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Retryable server answers beyond this drop the photo — a mirror that hasn't
 *  absorbed the work order after this many ticks isn't going to. */
export const MAX_UPLOAD_ATTEMPTS = 30;

export function enqueuePhoto(
  queue: WorkOrderPhotoQueue,
  entry: { photoId: string; workOrderId: string; phase: WorkOrderPhotoPhase; queuedAt: number },
): WorkOrderPhotoQueue {
  return { ...queue, [entry.photoId]: { ...entry, attempts: 0 } };
}

/** Entries oldest-first, so uploads land in capture order. */
export function uploadOrder(queue: WorkOrderPhotoQueue): PendingWorkOrderPhoto[] {
  return Object.values(queue).sort(
    (a, b) => a.queuedAt - b.queuedAt || a.photoId.localeCompare(b.photoId),
  );
}

/** How one upload attempt ended, as the queue cares about it. */
export type UploadSettlement =
  /** 201 — drop the entry and the local file. */
  | "uploaded"
  /** Local file vanished — nothing to upload; drop the entry. */
  | "missing"
  /** Rejected outright (bad payload/auth) — retrying forever won't help. */
  | "fatal"
  /** Transient (404 mirror lag, 429, 5xx) — count it against the budget. */
  | "retryable"
  /** Network unreachable — the queue holds, no budget spent. */
  | "offline";

/** Map an HTTP outcome from uploadWorkOrderPhoto onto a settlement. */
export function settlementForOutcome(outcome: WorkOrderPhotoUploadOutcome): UploadSettlement {
  if (outcome.ok) return "uploaded";
  return outcome.retry ? "retryable" : "fatal";
}

/**
 * Apply one settlement. `deleteFile` tells the caller whether the local JPEG
 * is done for (uploaded, rejected, or out of retries).
 */
export function settlePhoto(
  queue: WorkOrderPhotoQueue,
  photoId: string,
  settlement: UploadSettlement,
): { queue: WorkOrderPhotoQueue; deleteFile: boolean } {
  const entry = queue[photoId];
  if (!entry || settlement === "offline") return { queue, deleteFile: false };

  if (settlement === "retryable") {
    const attempts = entry.attempts + 1;
    if (attempts < MAX_UPLOAD_ATTEMPTS) {
      return { queue: { ...queue, [photoId]: { ...entry, attempts } }, deleteFile: false };
    }
    // Budget exhausted — fall through to a drop, file included.
  }

  const next = { ...queue };
  delete next[photoId];
  return { queue: next, deleteFile: settlement !== "missing" };
}

/** Drop stale entries; returns the dropped ids so their files can go too. */
export function pruneQueue(
  queue: WorkOrderPhotoQueue,
  nowMs: number,
): { queue: WorkOrderPhotoQueue; droppedIds: string[] } {
  const droppedIds = Object.values(queue)
    .filter((entry) => nowMs - entry.queuedAt > PHOTO_STALE_MS)
    .map((entry) => entry.photoId);
  if (droppedIds.length === 0) return { queue, droppedIds };
  const next = { ...queue };
  for (const id of droppedIds) delete next[id];
  return { queue: next, droppedIds };
}

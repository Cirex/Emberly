import type { PendingClose } from "@/lib/stores/pending-closes";
import type { PendingEdit } from "@/lib/stores/pending-edits";
import type { WorkOrderEditPatch } from "@/lib/api/work-orders";
import type { WorkOrderPhotoQueue } from "@/lib/work-order-photo-queue";

/**
 * The outbox: every field write still on its way to ResMan, as one read-only
 * list. Closes, edits, and photos already persist to the device and flush on
 * the sync tick — this derives a unified view over those same stores so a tech
 * in a no-signal basement can see the work is captured. Pure; the screen owns
 * rendering and the "Sync now" action.
 */

export type OutboxKind = "close" | "photo" | "edit";

/**
 * - `blocked`  — ResMan REFUSED it (locked field, ticket closed/cancelled,
 *                form drift). Nothing was written and the automatic flush has
 *                stopped trying: the tech has to act. Distinct from `sent` on
 *                purpose — this is exactly the state that used to be filed as
 *                delivered, which is how typed notes disappeared silently.
 * - `sending`  — a flush is in flight right now (photos only expose this)
 * - `queued`   — waiting for the next sync / for signal; no attempts yet
 * - `retrying` — failed at least once, will try again on the next tick
 * - `sent`     — the server accepted it; confirming against the mirror
 */
export type OutboxState = "blocked" | "sending" | "queued" | "retrying" | "sent";

/** An edited field, as a stable key the screen localizes. */
export type EditField = "notes" | "description" | "assignment";

export interface OutboxItem {
  /** Stable per row, so a list key never collides across kinds. */
  id: string;
  kind: OutboxKind;
  workOrderId: string;
  state: OutboxState;
  /** Delivery attempts so far; 0 until the first server-answered try. */
  attempts: number;
  /** Epoch ms the item was queued — the sort tiebreaker (oldest first). */
  queuedAt: number;
  /** Photos collapsed into this row (kind === "photo"). */
  photoCount?: number;
  /** Fields an edit touches (kind === "edit"), for a localized title. */
  editFields?: EditField[];
  /** The last delivery failure for closes/edits — shown verbatim on the row. */
  lastError?: string;
}

/** Which fields an edit touches, as keys — the screen turns these into words. */
export function editFields(patch: WorkOrderEditPatch): EditField[] {
  const fields: EditField[] = [];
  if (patch.completionNotes !== undefined) fields.push("notes");
  if (patch.description !== undefined) fields.push("description");
  if (patch.technician !== undefined) fields.push("assignment");
  return fields;
}

function closeState(c: PendingClose): OutboxState {
  if (c.acked) return "sent";
  return (c.attempts ?? 1) > 1 ? "retrying" : "queued";
}

// Order the sections read top to bottom: what needs a human, what's moving,
// what's stuck, what's waiting, what's done — most-actionable first.
const STATE_RANK: Record<OutboxState, number> = {
  blocked: 0,
  sending: 1,
  retrying: 2,
  queued: 3,
  sent: 4,
};

export interface OutboxInput {
  closes: PendingClose[];
  edits: PendingEdit[];
  photos: WorkOrderPhotoQueue;
  /** The photo store's live flush flag — the only "sending" signal we have. */
  photosSyncing: boolean;
}

/**
 * Build the ordered outbox. Photos of the same work order collapse into one
 * row ("N completion photos") so a burst of captures doesn't flood the list;
 * their state is the least-settled of the group (a sending photo makes the row
 * sending). Sorted by state rank, then oldest first within a state.
 */
export function buildOutbox(input: OutboxInput): OutboxItem[] {
  const items: OutboxItem[] = [];

  for (const c of input.closes) {
    // Delivered (acked = verified in ResMan). The entry itself lives on only
    // so the optimistic overlay keeps rendering until the mirror absorbs it —
    // an internal detail, not outbox material: this list is writes still on
    // their way, and a verified write is not.
    if (c.acked) continue;
    items.push({
      id: `close:${c.workOrderId}`,
      kind: "close",
      workOrderId: c.workOrderId,
      state: closeState(c),
      attempts: c.attempts ?? 1,
      queuedAt: c.queuedAt,
      lastError: c.acked ? undefined : c.lastError,
    });
  }

  for (const e of input.edits) {
    if (e.acked) continue; // delivered — same reasoning as closes above
    // A refused edit is the one thing on this screen that will NOT resolve on
    // its own, so it leads the list and shows ResMan's reason verbatim.
    const blocked = e.blockedReason !== undefined;
    items.push({
      id: `edit:${e.workOrderId}`,
      kind: "edit",
      workOrderId: e.workOrderId,
      state: blocked ? "blocked" : "queued",
      attempts: 0,
      queuedAt: e.editedAt,
      editFields: editFields(e.patch),
      lastError: e.blockedReason ?? e.lastError,
    });
  }

  // Collapse photos per work order.
  const byWo = new Map<string, { count: number; attempts: number; queuedAt: number }>();
  for (const p of Object.values(input.photos)) {
    const g = byWo.get(p.workOrderId) ?? { count: 0, attempts: 0, queuedAt: p.queuedAt };
    g.count += 1;
    g.attempts = Math.max(g.attempts, p.attempts);
    g.queuedAt = Math.min(g.queuedAt, p.queuedAt);
    byWo.set(p.workOrderId, g);
  }
  for (const [workOrderId, g] of byWo) {
    const state: OutboxState = input.photosSyncing
      ? "sending"
      : g.attempts > 0
        ? "retrying"
        : "queued";
    items.push({
      id: `photo:${workOrderId}`,
      kind: "photo",
      workOrderId,
      state,
      attempts: g.attempts,
      queuedAt: g.queuedAt,
      photoCount: g.count,
    });
  }

  return items.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.queuedAt - b.queuedAt);
}

/** Count of items not yet accepted by the server — the tab/settings badge.
 *  Blocked counts: the write did not happen, and a badge that hides it would
 *  be the same lie as acking it. */
export function pendingCount(items: OutboxItem[]): number {
  return items.filter((i) => i.state !== "sent").length;
}

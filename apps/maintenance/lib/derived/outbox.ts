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
 * - `sending`  — a flush is in flight right now (photos only expose this)
 * - `queued`   — waiting for the next sync / for signal; no attempts yet
 * - `retrying` — failed at least once, will try again on the next tick
 * - `sent`     — the server accepted it; confirming against the mirror
 */
export type OutboxState = "sending" | "queued" | "retrying" | "sent";

export interface OutboxItem {
  /** Stable per row, so a list key never collides across kinds. */
  id: string;
  kind: OutboxKind;
  workOrderId: string;
  /** Human title, e.g. "Marked complete" / "2 completion photos". */
  title: string;
  state: OutboxState;
  /** Delivery attempts so far; 0 until the first server-answered try. */
  attempts: number;
  /** Epoch ms the item was queued — the sort tiebreaker (oldest first). */
  queuedAt: number;
}

/** Which fields an edit touches, named for the tech ("technician notes"). */
export function editSummary(patch: WorkOrderEditPatch): string {
  const parts: string[] = [];
  if (patch.completionNotes !== undefined) parts.push("technician notes");
  if (patch.description !== undefined) parts.push("description");
  if (patch.technician !== undefined) parts.push("assignment");
  if (parts.length === 0) return "Edit";
  const joined = parts.join(" · ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function closeState(c: PendingClose): OutboxState {
  if (c.acked) return "sent";
  return (c.attempts ?? 1) > 1 ? "retrying" : "queued";
}

// Order the sections read top to bottom: what's moving, what's stuck, what's
// waiting, what's done — most-actionable first.
const STATE_RANK: Record<OutboxState, number> = { sending: 0, retrying: 1, queued: 2, sent: 3 };

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
    items.push({
      id: `close:${c.workOrderId}`,
      kind: "close",
      workOrderId: c.workOrderId,
      title: "Marked complete",
      state: closeState(c),
      attempts: c.attempts ?? 1,
      queuedAt: c.queuedAt,
    });
  }

  for (const e of input.edits) {
    items.push({
      id: `edit:${e.workOrderId}`,
      kind: "edit",
      workOrderId: e.workOrderId,
      title: editSummary(e.patch),
      state: e.acked ? "sent" : "queued",
      attempts: 0,
      queuedAt: e.editedAt,
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
      title: g.count === 1 ? "1 completion photo" : `${g.count} completion photos`,
      state,
      attempts: g.attempts,
      queuedAt: g.queuedAt,
    });
  }

  return items.sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.queuedAt - b.queuedAt,
  );
}

/** Count of items not yet accepted by the server — the tab/settings badge. */
export function pendingCount(items: OutboxItem[]): number {
  return items.filter((i) => i.state !== "sent").length;
}

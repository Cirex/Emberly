import { technicianDisplayName } from "@emberly/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
import { editWorkOrder, type WorkOrder, type WorkOrderEditPatch } from "@/lib/api/work-orders";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Optimistic "edited, pending ResMan" overlay — the sibling of pending-closes
 * for the detail screen's edits (technician reassignment, description,
 * technician notes). The server queues each edit durably and the sync worker
 * replays it into ResMan minutes later, so this store is the app's memory of
 * what the technician changed in the meantime. The detail screen renders
 * overlay values over the base row; entries retire on their own once the sync
 * mirror reports the base row absorbed every edited field (or after the stale
 * window, so an entry whose write failed server-side can't shadow reality
 * forever).
 */

export interface PendingEdit {
  workOrderId: string;
  patch: WorkOrderEditPatch;
  editedAt: number;
  /** True once the server accepted (even as a stub); false = local-only, retry. */
  acked: boolean;
  /** The last delivery failure, verbatim — surfaced in the outbox so a stuck
   *  entry says WHY instead of just counting attempts. Cleared on ack. */
  lastError?: string;
  /** Epoch ms of the last successful delivery (ack) — the redeliver clock
   *  runs from here, never from editedAt (see pending-closes). */
  ackedAt?: number;
}

/** An edit older than this is dropped at prune — a write the flusher kept
 *  refusing would otherwise shadow the base row forever. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** An ACKED edit the mirror has not absorbed after this long gets un-acked
 *  and redelivered — same reasoning as pending-closes (stub-era acks, or an
 *  ack whose write silently failed to stick). Idempotent: an edit that
 *  landed re-acks as a no-op on one GET. */
const REDELIVER_MS = 30 * 60 * 1000;

interface PendingEditsState {
  pending: Record<string, PendingEdit>;
  /** Optimistically merge a patch and tell the server. Resolves ok even when
   *  the server is unreachable — the entry stays un-acked for a later retry. */
  queueEdit: (workOrderId: string, patch: WorkOrderEditPatch, config: StaffConfig) => Promise<void>;
  /** Retry any un-acked entries (called from the sync tick). */
  flush: (config: StaffConfig) => Promise<void>;
  /** Mark an entry delivered by SOMEONE ELSE's request — the coalesced close
   *  folds a pending edit into its own ResMan write, then acks it here. Only
   *  lands if the entry still holds exactly the patch that was folded in. */
  ackDelivered: (workOrderId: string, sent: WorkOrderEditPatch) => void;
  /** Drop entries the mirror has caught up with (base row matches every
   *  edited field) or stale ones. */
  prune: (rows: readonly WorkOrder[], nowMs: number) => void;
  remove: (workOrderId: string) => void;
}

/**
 * Stable fingerprint of a patch, used to decide whether the entry still holds
 * the SAME edit that was just sent. Keys are sorted so two equal patches can
 * never compare unequal because of insertion order.
 */
function fingerprint(patch: WorkOrderEditPatch): string {
  return JSON.stringify(Object.entries(patch).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Mark an entry accepted, but ONLY if it still holds the edit that was sent.
 *
 * The write is awaited, and the technician can keep typing while it is in
 * flight. `queueEdit` merges the newer keystrokes into the same entry, so
 * acking blindly marked the NEWER patch as accepted by a request that never
 * carried it — the tech's last edit was silently dropped, forever, since
 * `flush` only ever retries un-acked entries. Leaving it un-acked instead costs
 * one extra PATCH on the next tick.
 */
function ackIfUnchanged(
  set: (fn: (s: PendingEditsState) => Partial<PendingEditsState>) => void,
  workOrderId: string,
  sent: WorkOrderEditPatch,
): void {
  const sentPrint = fingerprint(sent);
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || fingerprint(cur.patch) !== sentPrint) return s;
    return {
      pending: {
        ...s.pending,
        [workOrderId]: { ...cur, acked: true, ackedAt: Date.now(), lastError: undefined },
      },
    };
  });
}

/** Same instant, whatever format each side spells it in. */
function sameMoment(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || a === "") return b == null || b === "";
  if (b == null || b === "") return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  // Unparseable on either side falls back to an exact string match rather than
  // reporting two NaNs equal, which would retire an edit that never landed.
  return Number.isNaN(ta) || Number.isNaN(tb) ? a === b : ta === tb;
}

/** ResMan round-trips free text with \r\n line endings and can pad edges;
 *  compare CONTENT, not bytes, or a multi-line note never reads as absorbed
 *  (field-verified: an acked edit oscillated forever on exactly this). */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").replace(/\r\n/g, "\n").trim();
  return norm(a) === norm(b);
}

/** True when the base row already carries every value the patch sets. */
function absorbed(row: WorkOrder, patch: WorkOrderEditPatch): boolean {
  // Technician compares in DISPLAY space: the patch carries the display form
  // ("Unassigned", "Grounds Keepers") while the mirror carries ResMan's raw
  // value ("" / "GROUNDS KEEPING") — a byte compare never absorbs a clear.
  if (
    patch.technician !== undefined &&
    technicianDisplayName(row.technician ?? "") !== technicianDisplayName(patch.technician)
  ) {
    return false;
  }
  if (patch.description !== undefined && !sameText(row.notes, patch.description)) return false;
  if (
    patch.completionNotes !== undefined &&
    !sameText(row.completion_notes, patch.completionNotes)
  ) {
    return false;
  }
  // ResMan may echo the date back in a different format than we sent, so this
  // compares instants — a string match would keep the overlay alive forever.
  if (patch.scheduledAt !== undefined && !sameMoment(row.date_scheduled, patch.scheduledAt)) {
    return false;
  }
  return true;
}

/** One line of failure text — our own error messages carry no note contents. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function recordError(
  set: (fn: (s: PendingEditsState) => Partial<PendingEditsState>) => void,
  workOrderId: string,
  error: unknown,
): void {
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || cur.acked) return s;
    return { pending: { ...s.pending, [workOrderId]: { ...cur, lastError: errorText(error) } } };
  });
}

/** Module-scoped so it guards the ONE store, not a per-call closure. */
let flushing = false;

export const usePendingEdits = create<PendingEditsState>()(
  persist(
    (set, get) => ({
      pending: {},

      queueEdit: async (workOrderId, patch, config) => {
        const merged = { ...get().pending[workOrderId]?.patch, ...patch };
        set((s) => ({
          pending: {
            ...s.pending,
            [workOrderId]: { workOrderId, patch: merged, editedAt: Date.now(), acked: false },
          },
        }));
        try {
          await editWorkOrder(workOrderId, merged, config);
          ackIfUnchanged(set, workOrderId, merged);
        } catch (error) {
          // Keep it un-acked; flush() retries on the next sync tick.
          recordError(set, workOrderId, error);
        }
      },

      flush: async (config) => {
        // Re-entrancy guard. flush() is driven by the 60s sync tick AND by
        // AppState going active, and a slow request outlives the interval — so
        // two flushes overlapped routinely, each re-sending the same un-acked
        // edits. Against a real ResMan write that is duplicate work orders and
        // duplicate notes, not just wasted requests.
        if (flushing) return;
        flushing = true;
        try {
          const unacked = Object.values(get().pending).filter((p) => !p.acked);
          for (const entry of unacked) {
            try {
              await editWorkOrder(entry.workOrderId, entry.patch, config);
              ackIfUnchanged(set, entry.workOrderId, entry.patch);
            } catch (error) {
              recordError(set, entry.workOrderId, error); // next tick retries
            }
          }
        } finally {
          flushing = false;
        }
      },

      prune: (rows, nowMs) => {
        const byId = new Map(rows.map((r) => [r.resman_work_order_id, r]));
        set((s) => {
          let changed = false;
          const next: Record<string, PendingEdit> = {};
          for (const entry of Object.values(s.pending)) {
            const row = byId.get(entry.workOrderId);
            const retire =
              nowMs - entry.editedAt > STALE_MS ||
              (row !== undefined && absorbed(row, entry.patch));
            if (retire) {
              changed = true;
            } else if (entry.acked && nowMs - (entry.ackedAt ?? 0) > REDELIVER_MS) {
              // Acked but never absorbed — redeliver (see REDELIVER_MS).
              next[entry.workOrderId] = { ...entry, acked: false };
              changed = true;
            } else {
              next[entry.workOrderId] = entry;
            }
          }
          return changed ? { pending: next } : s;
        });
      },

      ackDelivered: (workOrderId, sent) => {
        ackIfUnchanged(set, workOrderId, sent);
      },

      remove: (workOrderId) => {
        set((s) => {
          if (!(workOrderId in s.pending)) return s;
          const next = { ...s.pending };
          delete next[workOrderId];
          return { pending: next };
        });
      },
    }),
    {
      name: "emberly-maintenance-pending-edits",
      storage: persistedStorage(),
      partialize: (s) => ({ pending: s.pending }),
    },
  ),
);

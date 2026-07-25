import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { editWorkOrder, type WorkOrder, type WorkOrderEditPatch } from "@/lib/api/work-orders";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Optimistic "edited, pending ResMan" overlay — the sibling of pending-closes
 * for the detail screen's edits (technician reassignment, description,
 * technician notes). The real write to ResMan doesn't exist yet — the server
 * route is a stub that answers queued:true — so this store is the app's
 * memory of what the technician changed. The detail screen renders overlay
 * values over the base row; entries retire on their own once the sync mirror
 * reports the base row absorbed every edited field (or after the stale
 * window, so a stub entry can't shadow reality forever).
 */

export interface PendingEdit {
  workOrderId: string;
  patch: WorkOrderEditPatch;
  editedAt: number;
  /** True once the server accepted (even as a stub); false = local-only, retry. */
  acked: boolean;
}

/** An edit older than this is dropped at prune — with the write path stubbed,
 *  an entry can otherwise outlive its usefulness. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingEditsState {
  pending: Record<string, PendingEdit>;
  /** Optimistically merge a patch and tell the server. Resolves ok even when
   *  the server is unreachable — the entry stays un-acked for a later retry. */
  queueEdit: (workOrderId: string, patch: WorkOrderEditPatch, config: StaffConfig) => Promise<void>;
  /** Retry any un-acked entries (called from the sync tick). */
  flush: (config: StaffConfig) => Promise<void>;
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
    return { pending: { ...s.pending, [workOrderId]: { ...cur, acked: true } } };
  });
}

/** True when the base row already carries every value the patch sets. */
function absorbed(row: WorkOrder, patch: WorkOrderEditPatch): boolean {
  if (patch.technician !== undefined && row.technician !== patch.technician) return false;
  if (patch.description !== undefined && row.notes !== patch.description) return false;
  if (patch.completionNotes !== undefined && row.completion_notes !== patch.completionNotes) {
    return false;
  }
  return true;
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
        } catch {
          // Keep it un-acked; flush() retries on the next sync tick.
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
            } catch {
              /* still unreachable — next tick */
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
              nowMs - entry.editedAt > STALE_MS || (row !== undefined && absorbed(row, entry.patch));
            if (retire) changed = true;
            else next[entry.workOrderId] = entry;
          }
          return changed ? { pending: next } : s;
        });
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
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ pending: s.pending }),
    },
  ),
);

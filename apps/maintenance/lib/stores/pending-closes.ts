import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { capture } from "@/lib/analytics";
import { closeWorkOrder } from "@/lib/api/work-orders";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Optimistic "closed, pending ResMan" overlay. The real close write to ResMan
 * doesn't exist yet — the server route is a stub that answers queued:true —
 * so this store is the app's memory of which work orders the technician has
 * closed. Screens consult it to render those rows as closed; entries retire
 * on their own once the sync mirror reports the base row actually closed
 * (or after the stale window, so a stub entry can't shadow reality forever).
 */

export interface PendingClose {
  workOrderId: string;
  note: string;
  queuedAt: number;
  /** True once the server accepted (even as a stub); false = local-only, retry. */
  acked: boolean;
  /**
   * Close attempts made so far (the immediate try plus flush retries). Rows
   * persisted before this field exists have made at least the immediate
   * attempt, so a missing value reads as 1.
   */
  attempts?: number;
}

/** A pending close older than this is dropped at hydrate/prune — with the
 *  write path stubbed, an entry can otherwise outlive its usefulness. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingClosesState {
  pending: Record<string, PendingClose>;
  /** Optimistically mark closed and tell the server. Resolves ok even when the
   *  server is unreachable — the entry just stays un-acked for a later retry. */
  queueClose: (workOrderId: string, note: string, config: StaffConfig) => Promise<void>;
  /** Retry any un-acked entries (called from the sync tick). */
  flush: (config: StaffConfig) => Promise<void>;
  /** Drop entries the mirror has caught up with (base row closed) or stale ones. */
  prune: (closedIds: ReadonlySet<string>, nowMs: number) => void;
  remove: (workOrderId: string) => void;
}

export const usePendingCloses = create<PendingClosesState>()(
  persist(
    (set, get) => ({
      pending: {},

      queueClose: async (workOrderId, note, config) => {
        set((s) => ({
          pending: {
            ...s.pending,
            [workOrderId]: { workOrderId, note, queuedAt: Date.now(), acked: false, attempts: 1 },
          },
        }));
        try {
          await closeWorkOrder(workOrderId, note, config);
          set((s) => {
            const entry = s.pending[workOrderId];
            if (!entry) return s;
            return { pending: { ...s.pending, [workOrderId]: { ...entry, acked: true } } };
          });
        } catch {
          // Keep it un-acked; flush() retries on the next sync tick.
        }
      },

      flush: async (config) => {
        const unacked = Object.values(get().pending).filter((p) => !p.acked);
        for (const entry of unacked) {
          // This flush try is one more attempt on top of whatever the entry
          // has already made (missing = the immediate try in queueClose).
          const attempts = (entry.attempts ?? 1) + 1;
          try {
            await closeWorkOrder(entry.workOrderId, entry.note, config);
            set((s) => {
              const cur = s.pending[entry.workOrderId];
              if (!cur) return s;
              return { pending: { ...s.pending, [entry.workOrderId]: { ...cur, acked: true, attempts } } };
            });
            // No PII: retry accounting + queue latency only.
            capture("pending_close_flushed", {
              retry_count: attempts,
              queued_ms: Date.now() - entry.queuedAt,
            });
          } catch {
            // Still unreachable — persist the attempt count for the next tick.
            set((s) => {
              const cur = s.pending[entry.workOrderId];
              if (!cur || cur.acked) return s;
              return { pending: { ...s.pending, [entry.workOrderId]: { ...cur, attempts } } };
            });
          }
        }
      },

      prune: (closedIds, nowMs) => {
        set((s) => {
          const next: Record<string, PendingClose> = {};
          let changed = false;
          for (const [id, entry] of Object.entries(s.pending)) {
            if (closedIds.has(id) || nowMs - entry.queuedAt > STALE_MS) {
              changed = true;
              continue;
            }
            next[id] = entry;
          }
          return changed ? { pending: next } : s;
        });
      },

      remove: (workOrderId) => {
        set((s) => {
          if (!s.pending[workOrderId]) return s;
          const next = { ...s.pending };
          delete next[workOrderId];
          return { pending: next };
        });
      },
    }),
    {
      name: "emberly-maintenance-pending-closes",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/** Convenience selector for screens: is this work order optimistically closed? */
export function isPendingClose(pending: Record<string, PendingClose>, workOrderId: string): boolean {
  return pending[workOrderId] !== undefined;
}

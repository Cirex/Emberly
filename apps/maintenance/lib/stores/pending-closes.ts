import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
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

/**
 * Mark an entry accepted, but ONLY if it still holds the note that was sent.
 * Returns whether the ack landed.
 *
 * The write is awaited, and the technician can re-close with a corrected note
 * while it is in flight — `queueClose` overwrites the entry and resets `acked`.
 * Acking blindly marked that NEWER note as accepted by a request that never
 * carried it, and since `flush` only retries un-acked entries, the corrected
 * note was silently dropped forever.
 */
function ackIfUnchanged(
  set: (fn: (s: PendingClosesState) => Partial<PendingClosesState>) => void,
  workOrderId: string,
  sentNote: string,
  attempts?: number,
): boolean {
  let acked = false;
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || cur.note !== sentNote) return s;
    acked = true;
    return {
      pending: {
        ...s.pending,
        [workOrderId]: { ...cur, acked: true, ...(attempts === undefined ? {} : { attempts }) },
      },
    };
  });
  return acked;
}

/** Module-scoped so it guards the ONE store, not a per-call closure. */
let flushing = false;

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
          ackIfUnchanged(set, workOrderId, note);
        } catch {
          // Keep it un-acked; flush() retries on the next sync tick.
        }
      },

      flush: async (config) => {
        // Re-entrancy guard. flush() is driven by the 60s sync tick AND by
        // AppState going active, and a slow request outlives the interval — so
        // two flushes overlapped routinely, each re-sending the same un-acked
        // closes. Against a real ResMan write that is a work order closed
        // twice, and it also double-counted `attempts` and fired the analytics
        // event twice per close.
        if (flushing) return;
        flushing = true;
        try {
          const unacked = Object.values(get().pending).filter((p) => !p.acked);
          for (const entry of unacked) {
            // This flush try is one more attempt on top of whatever the entry
            // has already made (missing = the immediate try in queueClose).
            const attempts = (entry.attempts ?? 1) + 1;
            try {
              await closeWorkOrder(entry.workOrderId, entry.note, config);
              const acked = ackIfUnchanged(set, entry.workOrderId, entry.note, attempts);
              // Only report a close that this request actually completed. If
              // the note changed while the request was in flight, the entry
              // stays queued and the event belongs to the later attempt.
              if (acked) {
                // No PII: retry accounting + queue latency only.
                capture("pending_close_flushed", {
                  retry_count: attempts,
                  queued_ms: Date.now() - entry.queuedAt,
                });
              }
            } catch {
              // Still unreachable — persist the attempt count for the next tick.
              set((s) => {
                const cur = s.pending[entry.workOrderId];
                if (!cur || cur.acked) return s;
                return { pending: { ...s.pending, [entry.workOrderId]: { ...cur, attempts } } };
              });
            }
          }
        } finally {
          flushing = false;
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
      storage: persistedStorage(),
    },
  ),
);

/** Convenience selector for screens: is this work order optimistically closed? */
export function isPendingClose(pending: Record<string, PendingClose>, workOrderId: string): boolean {
  return pending[workOrderId] !== undefined;
}

import { WorkOrderWriteRefused } from "@emberly/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
import { capture } from "@/lib/analytics";
import { closeWorkOrder } from "@/lib/api/work-orders";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Optimistic "closed, pending the mirror" overlay. The device writes each close
 * straight into ResMan (verified), but the mirror every screen reads only sees
 * it on the next server scrape, up to ten minutes later — so this store is the
 * app's memory of what the technician closed in the meantime. Every screen
 * renders those rows as closed through lib/derived/pending-overlay; entries
 * retire once the mirror reports the row closed (or after the stale window, so
 * an entry that never landed can't shadow reality forever).
 */

export interface PendingClose {
  workOrderId: string;
  note: string;
  queuedAt: number;
  /**
   * When the work was finished, epoch ms — set when the technician stamped a
   * completion date themselves rather than closing on the spot. Undefined means
   * "whenever the server records it", which is what every close did before the
   * date picker existed, so old persisted entries read correctly.
   */
  completedAt?: number;
  /** True once the server accepted (even as a stub); false = local-only, retry. */
  acked: boolean;
  /**
   * Close attempts made so far (the immediate try plus flush retries). Rows
   * persisted before this field exists have made at least the immediate
   * attempt, so a missing value reads as 1.
   */
  attempts?: number;
  /** The last delivery failure, verbatim — surfaced in the outbox so a stuck
   *  entry says WHY instead of just counting attempts. Cleared on ack. */
  lastError?: string;
  /** Epoch ms of the last successful delivery (ack). The redeliver clock runs
   *  from HERE, never from queuedAt — an age-based clock made every entry
   *  older than the window oscillate acked→unacked on each prune tick. */
  ackedAt?: number;
  /**
   * Why ResMan REFUSED this close (the ticket was Cancelled, form drift, a bad
   * completion date) — a verdict on these bytes, not a transport failure. The
   * same contract as PendingEdit.blockedReason: NOT an ack, because nothing was
   * written; the automatic flush skips it; the outbox shows the reason; and the
   * overlay does not paint the work order Completed. A manual "Sync now" asks
   * once more, since the guards read ResMan-side state the office can change.
   */
  blockedReason?: string;
}

/** A pending close older than this is dropped at hydrate/prune — a close the
 *  flusher kept refusing would otherwise shadow the base row forever. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An ACKED close whose work order the mirror STILL reports open after this
 * long gets un-acked and redelivered. Two real cases: stub-era entries the
 * old server "accepted" without ever writing ResMan (found in the field: a
 * close stuck at "syncing to ResMan" for days), and any future ack whose
 * write silently failed to stick. Safe because delivery is verify-first and
 * idempotent — a close that actually landed re-acks as a no-op on one GET.
 */
const REDELIVER_MS = 30 * 60 * 1000;

/**
 * Slack for comparing the server's `synced_at` against the device's `ackedAt`:
 * clock skew, plus a scrape that READ ResMan just before our write and stamped
 * the row just after it.
 */
const MIRROR_SKEW_MS = 2 * 60 * 1000;

interface PendingClosesState {
  pending: Record<string, PendingClose>;
  /** Optimistically mark closed and tell the server. Resolves ok even when the
   *  server is unreachable — the entry just stays un-acked for a later retry.
   *  `completedAt` (epoch ms) backdates the completion; omit for "now". */
  queueClose: (
    workOrderId: string,
    note: string,
    config: StaffConfig,
    completedAt?: number,
  ) => Promise<void>;
  /** Retry un-acked entries (called from the sync tick). Blocked ones are
   *  skipped unless `includeBlocked` — the outbox's manual "Sync now". */
  flush: (config: StaffConfig, opts?: { includeBlocked?: boolean }) => Promise<void>;
  /**
   * Drop entries the mirror has caught up with (base row closed) or stale ones.
   * `mirrorSyncedAt` maps a work order to when the server last scraped it
   * (epoch ms): an acked close whose row was re-scraped AFTER the ack and still
   * reads open was reopened by someone else, so it retires rather than being
   * redelivered over them.
   */
  prune: (
    closedIds: ReadonlySet<string>,
    nowMs: number,
    mirrorSyncedAt?: ReadonlyMap<string, number>,
  ) => void;
  remove: (workOrderId: string) => void;
}

/**
 * Mark an entry accepted, but ONLY if it still holds the close that was sent.
 * Returns whether the ack landed.
 *
 * The write is awaited, and the technician can re-close with a corrected note
 * or completion date while it is in flight — `queueClose` overwrites the entry
 * and resets `acked`. Acking blindly marked that NEWER close as accepted by a
 * request that never carried it, and since `flush` only retries un-acked
 * entries, the correction was silently dropped forever.
 */
function ackIfUnchanged(
  set: (fn: (s: PendingClosesState) => Partial<PendingClosesState>) => void,
  workOrderId: string,
  sentNote: string,
  sentCompletedAt: number | undefined,
  attempts?: number,
): boolean {
  let acked = false;
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || cur.note !== sentNote || cur.completedAt !== sentCompletedAt) return s;
    acked = true;
    return {
      pending: {
        ...s.pending,
        [workOrderId]: {
          ...cur,
          acked: true,
          ackedAt: Date.now(),
          lastError: undefined,
          blockedReason: undefined,
          ...(attempts === undefined ? {} : { attempts }),
        },
      },
    };
  });
  return acked;
}

/** Epoch ms to the ISO string the wire wants; undefined stays undefined so the
 *  body omits the field entirely and the server keeps deciding. */
function isoOrUndefined(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** One line of failure text — our own error messages carry no note contents. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * Record a REFUSAL: terminal but undelivered. Same fingerprint discipline as
 * `ackIfUnchanged` — a re-close with a corrected note while the request was in
 * flight is a different close that has never been offered to ResMan.
 */
function blockIfUnchanged(
  set: (fn: (s: PendingClosesState) => Partial<PendingClosesState>) => void,
  workOrderId: string,
  sentNote: string,
  sentCompletedAt: number | undefined,
  reason: string,
  attempts?: number,
): void {
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || cur.acked || cur.note !== sentNote || cur.completedAt !== sentCompletedAt) {
      return s;
    }
    return {
      pending: {
        ...s.pending,
        [workOrderId]: {
          ...cur,
          blockedReason: errorText(reason),
          lastError: undefined,
          ...(attempts === undefined ? {} : { attempts }),
        },
      },
    };
  });
}

function recordError(
  set: (fn: (s: PendingClosesState) => Partial<PendingClosesState>) => void,
  workOrderId: string,
  error: unknown,
): void {
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || cur.acked) return s;
    // A transport failure is not a verdict: back on the automatic clock.
    return {
      pending: {
        ...s.pending,
        [workOrderId]: { ...cur, lastError: errorText(error), blockedReason: undefined },
      },
    };
  });
}

/** Module-scoped so it guards the ONE store, not a per-call closure. */
let flushing = false;

export const usePendingCloses = create<PendingClosesState>()(
  persist(
    (set, get) => ({
      pending: {},

      queueClose: async (workOrderId, note, config, completedAt) => {
        set((s) => ({
          pending: {
            ...s.pending,
            [workOrderId]: {
              workOrderId,
              note,
              completedAt,
              queuedAt: Date.now(),
              acked: false,
              attempts: 1,
            },
          },
        }));
        try {
          await closeWorkOrder(workOrderId, note, config, isoOrUndefined(completedAt));
          ackIfUnchanged(set, workOrderId, note, completedAt);
        } catch (error) {
          if (error instanceof WorkOrderWriteRefused) {
            blockIfUnchanged(set, workOrderId, note, completedAt, error.message);
          } else {
            // Keep it un-acked; flush() retries on the next sync tick.
            recordError(set, workOrderId, error);
          }
        }
      },

      flush: async (config, opts) => {
        // Re-entrancy guard. flush() is driven by the 60s sync tick AND by
        // AppState going active, and a slow request outlives the interval — so
        // two flushes overlapped routinely, each re-sending the same un-acked
        // closes. Against a real ResMan write that is a work order closed
        // twice, and it also double-counted `attempts` and fired the analytics
        // event twice per close.
        if (flushing) return;
        flushing = true;
        try {
          const retryBlocked = opts?.includeBlocked ?? false;
          const unacked = Object.values(get().pending).filter(
            (p) => !p.acked && (retryBlocked || p.blockedReason === undefined),
          );
          for (const entry of unacked) {
            // This flush try is one more attempt on top of whatever the entry
            // has already made (missing = the immediate try in queueClose).
            const attempts = (entry.attempts ?? 1) + 1;
            try {
              await closeWorkOrder(
                entry.workOrderId,
                entry.note,
                config,
                isoOrUndefined(entry.completedAt),
              );
              const acked = ackIfUnchanged(
                set,
                entry.workOrderId,
                entry.note,
                entry.completedAt,
                attempts,
              );
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
            } catch (error) {
              if (error instanceof WorkOrderWriteRefused) {
                blockIfUnchanged(
                  set,
                  entry.workOrderId,
                  entry.note,
                  entry.completedAt,
                  error.message,
                  attempts,
                );
                continue;
              }
              // Still failing — persist the attempt count and the reason.
              set((s) => {
                const cur = s.pending[entry.workOrderId];
                if (!cur || cur.acked) return s;
                return {
                  pending: {
                    ...s.pending,
                    [entry.workOrderId]: {
                      ...cur,
                      attempts,
                      lastError: errorText(error),
                      blockedReason: undefined,
                    },
                  },
                };
              });
            }
          }
        } finally {
          flushing = false;
        }
      },

      prune: (closedIds, nowMs, mirrorSyncedAt) => {
        set((s) => {
          const next: Record<string, PendingClose> = {};
          let changed = false;
          for (const [id, entry] of Object.entries(s.pending)) {
            if (closedIds.has(id) || nowMs - entry.queuedAt > STALE_MS) {
              changed = true;
              continue;
            }
            // Clock from the last ack; a stub-era entry persisted without
            // ackedAt reads as never-delivered and redelivers immediately.
            // The mirror re-scraped this row AFTER our verified close and it
            // still reads open: the office reopened it. Stand down — a
            // redeliver would silently re-close their work order.
            const seen = mirrorSyncedAt?.get(id);
            if (
              entry.acked &&
              entry.ackedAt !== undefined &&
              seen !== undefined &&
              seen > entry.ackedAt + MIRROR_SKEW_MS
            ) {
              changed = true;
              continue;
            }
            if (entry.acked && nowMs - (entry.ackedAt ?? 0) > REDELIVER_MS) {
              // The mirror never confirmed this ack — redeliver (see
              // REDELIVER_MS). Verify-first delivery makes this a no-op when
              // the close actually landed.
              next[id] = { ...entry, acked: false };
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

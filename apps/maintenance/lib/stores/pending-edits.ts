import {
  WorkOrderWriteRefused,
  normalizeResManFreeText,
  parseDate,
  sanitizeDescription,
  technicianDisplayName,
} from "@emberly/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
import { editWorkOrder, type WorkOrder, type WorkOrderEditPatch } from "@/lib/api/work-orders";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Optimistic "edited, pending the mirror" overlay — the sibling of
 * pending-closes for the detail screen's edits (technician reassignment,
 * description, technician notes, scheduled date). The device writes each edit
 * straight into ResMan (verified), but the mirror only sees it on the next
 * server scrape, so this store is the app's memory of what the technician
 * changed in the meantime. Every screen renders it through
 * lib/derived/pending-overlay; entries retire once the mirror absorbs every
 * edited field (or after the stale window, so an entry that never landed
 * can't shadow reality forever).
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
  /**
   * Why ResMan REFUSED this edit — a guard verdict (Description locked on this
   * work order, the office already Closed it, form drift), not a transport
   * failure. Re-sending the same bytes cannot change the answer, so the
   * automatic flush skips a blocked entry.
   *
   * It is deliberately NOT an ack. `acked` means one thing only — these exact
   * values are verified present in ResMan — and a refusal wrote nothing. The
   * two used to be conflated ("deterministic, so consume it"), which retired
   * the entry as Delivered and lost the technician's typed notes silently.
   * Blocked instead keeps the entry, stops the pointless retries, and gives
   * the outbox a reason to show, so the tech knows the office must do it.
   *
   * Cleared whenever the entry gets a fresh answer: a new edit, a successful
   * redelivery, or a transport failure on a manual retry (which puts it back
   * on the automatic clock).
   */
  blockedReason?: string;
}

/** An edit older than this is dropped at prune — a write the flusher kept
 *  refusing would otherwise shadow the base row forever. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** An ACKED edit the mirror has not absorbed after this long gets un-acked
 *  and redelivered — same reasoning as pending-closes (stub-era acks, or an
 *  ack whose write silently failed to stick). Idempotent: an edit that
 *  landed re-acks as a no-op on one GET. */
const REDELIVER_MS = 30 * 60 * 1000;

/**
 * Slack for comparing the server's `synced_at` against the device's `ackedAt`:
 * clock skew, plus a scrape that READ ResMan just before our write and stamped
 * the row just after it.
 */
const MIRROR_SKEW_MS = 2 * 60 * 1000;

interface PendingEditsState {
  pending: Record<string, PendingEdit>;
  /** Optimistically merge a patch and tell the server. Resolves ok even when
   *  the server is unreachable — the entry stays un-acked for a later retry. */
  queueEdit: (workOrderId: string, patch: WorkOrderEditPatch, config: StaffConfig) => Promise<void>;
  /**
   * Retry un-acked entries (called from the sync tick). Entries ResMan
   * REFUSED are skipped — the same bytes get the same verdict — unless
   * `includeBlocked` is set, which is what the outbox's manual "Sync now"
   * does: the guard reads ResMan-side state (status, a locked field) that
   * the office can change, so a tech who just phoned it in gets one more try
   * on demand rather than a dead end.
   */
  flush: (config: StaffConfig, opts?: { includeBlocked?: boolean }) => Promise<void>;
  /** Mark an entry delivered by SOMEONE ELSE's request — the coalesced close
   *  folds a pending edit into its own ResMan write, then acks it here. Only
   *  lands if the entry still holds exactly the patch that was folded in.
   *
   *  `written` is what that request ACTUALLY wrote, when the folding request
   *  superseded a field (a close's own note beats folded typed notes). The
   *  entry is re-based onto it, because an entry acked with a value ResMan
   *  never received can never be absorbed — and the redeliver clock would
   *  re-send the superseded value back over the one that landed. */
  ackDelivered: (
    workOrderId: string,
    sent: WorkOrderEditPatch,
    written?: WorkOrderEditPatch,
  ) => void;
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
  written?: WorkOrderEditPatch,
): void {
  const sentPrint = fingerprint(sent);
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || fingerprint(cur.patch) !== sentPrint) return s;
    return {
      pending: {
        ...s.pending,
        [workOrderId]: {
          ...cur,
          // Re-base onto what the write actually put in ResMan, so absorption
          // compares the mirror against a value it can really hold and a
          // redeliver can only ever re-send what already landed.
          patch: written ?? cur.patch,
          acked: true,
          ackedAt: Date.now(),
          lastError: undefined,
          // A delivered entry is no longer blocked — clearing this is what lets
          // a previously-refused edit leave the outbox once it finally lands.
          blockedReason: undefined,
        },
      },
    };
  });
}

/**
 * Record a REFUSAL: the write is terminal but undelivered.
 *
 * Same fingerprint discipline as `ackIfUnchanged` — if the technician typed
 * more while the request was in flight, the entry now holds a DIFFERENT patch
 * that has never been offered to ResMan, and blocking it on a verdict about
 * the older bytes would strand an edit that might well land.
 */
function blockIfUnchanged(
  set: (fn: (s: PendingEditsState) => Partial<PendingEditsState>) => void,
  workOrderId: string,
  sent: WorkOrderEditPatch,
  reason: string,
): void {
  const sentPrint = fingerprint(sent);
  set((s) => {
    const cur = s.pending[workOrderId];
    if (!cur || cur.acked || fingerprint(cur.patch) !== sentPrint) return s;
    return {
      pending: {
        ...s.pending,
        [workOrderId]: { ...cur, blockedReason: errorText(reason), lastError: undefined },
      },
    };
  });
}

/**
 * Same calendar day, whatever format each side spells it in.
 *
 * The mirror's `date_scheduled` is a Postgres `date` ("2026-09-24") while the
 * edit carries the full instant the tech picked ("2026-09-24T19:30:00.000Z").
 * Comparing instants meant a scheduled-date edit could NEVER absorb: its
 * overlay lingered the full stale window and the redeliver clock re-wrote it
 * into ResMan every half hour. The day is the most the mirror can confirm, so
 * the day is what is compared — in LOCAL time, the way parseDate reads the
 * mirror's date-only strings and the way ResMan records the date.
 */
function sameDay(mirror: string | null | undefined, picked: string | null | undefined): boolean {
  if (mirror == null || mirror === "") return picked == null || picked === "";
  if (picked == null || picked === "") return false;
  const a = parseDate(mirror);
  const b = parseDate(picked);
  // Unparseable on either side falls back to an exact string match rather than
  // reporting two nulls equal, which would retire an edit that never landed.
  if (a === null || b === null) return mirror === picked;
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** ResMan round-trips free text with \r\n line endings and can pad edges;
 *  compare CONTENT, not bytes, or a multi-line note never reads as absorbed
 *  (field-verified: an acked edit oscillated forever on exactly this). The
 *  normalizer comes from the write engine so this check and the engine's own
 *  verify can never drift into disagreeing about what we wrote. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeResManFreeText(a) === normalizeResManFreeText(b);
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
  // The mirror can only ever hold what the engine actually WROTE, and the
  // engine sanitizes the description ('<'/'>' stripped, 248 max). Comparing
  // the raw typed text instead means a long or bracketed edit never absorbs:
  // the "Saved" pill sticks for the full stale window and the redeliver clock
  // re-POSTs the identical edit every half hour.
  if (
    patch.description !== undefined &&
    !sameText(row.notes, sanitizeDescription(patch.description))
  ) {
    return false;
  }
  if (
    patch.completionNotes !== undefined &&
    !sameText(row.completion_notes, patch.completionNotes)
  ) {
    return false;
  }
  // The mirror holds only the day (see sameDay) — a string or instant match
  // would keep the overlay alive forever.
  if (patch.scheduledAt !== undefined && !sameDay(row.date_scheduled, patch.scheduledAt)) {
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
    // A transport failure is not a verdict: clear any earlier block so the
    // entry goes back on the automatic retry clock instead of staying stuck
    // behind a refusal ResMan no longer gives.
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
          // A refusal is ResMan's verdict on these bytes — terminal, but NOT
          // delivered. Anything else is transport: keep it un-acked and let
          // flush() retry on the next sync tick.
          if (error instanceof WorkOrderWriteRefused) {
            blockIfUnchanged(set, workOrderId, merged, error.message);
          } else {
            recordError(set, workOrderId, error);
          }
        }
      },

      flush: async (config, opts) => {
        // Re-entrancy guard. flush() is driven by the 60s sync tick AND by
        // AppState going active, and a slow request outlives the interval — so
        // two flushes overlapped routinely, each re-sending the same un-acked
        // edits. Against a real ResMan write that is duplicate work orders and
        // duplicate notes, not just wasted requests.
        if (flushing) return;
        flushing = true;
        try {
          const retryBlocked = opts?.includeBlocked ?? false;
          const unacked = Object.values(get().pending).filter(
            (p) => !p.acked && (retryBlocked || p.blockedReason === undefined),
          );
          for (const entry of unacked) {
            try {
              await editWorkOrder(entry.workOrderId, entry.patch, config);
              ackIfUnchanged(set, entry.workOrderId, entry.patch);
            } catch (error) {
              if (error instanceof WorkOrderWriteRefused) {
                // Blocked, not delivered — see PendingEdit.blockedReason. The
                // entry stays in the outbox with the reason on it.
                blockIfUnchanged(set, entry.workOrderId, entry.patch, error.message);
              } else {
                recordError(set, entry.workOrderId, error); // next tick retries
              }
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
            // The mirror re-scraped this row AFTER our verified write and it
            // still disagrees: someone else (the office) changed the field
            // since. Their value is the newer one — stand down rather than let
            // the redeliver clock write ours back over it.
            const seen = row?.synced_at ? Date.parse(row.synced_at) : NaN;
            const overtaken =
              entry.acked &&
              entry.ackedAt !== undefined &&
              !Number.isNaN(seen) &&
              seen > entry.ackedAt + MIRROR_SKEW_MS;
            if (retire || overtaken) {
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

      ackDelivered: (workOrderId, sent, written) => {
        ackIfUnchanged(set, workOrderId, sent, written);
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

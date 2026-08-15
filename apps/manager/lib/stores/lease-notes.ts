import { create } from "zustand";
import {
  createLeaseNote,
  fetchLeaseNotes,
  type LeaseNote,
} from "@/lib/api/lease-notes";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Per-lease notes threads for the pipeline detail sheet. Deliberately NOT on
 * the sync tick and NOT persisted: a thread loads when its sheet opens (one
 * lease at a time), so polling every thread each minute would be pure waste —
 * the exact pattern the network audit flagged. The cache keeps the last-seen
 * thread per lease so a reopened sheet paints instantly while refreshing.
 */
interface LeaseNotesState {
  /** Thread per lease id, oldest first (server order). */
  byLease: Record<string, LeaseNote[]>;
  loading: Record<string, boolean>;
  load: (config: StaffConfig, leaseId: string) => Promise<void>;
  /**
   * Optimistic post: the note appears at once (author from the signed-in
   * admin), the POST runs behind it, and the server row replaces the local
   * one. On failure the local row is removed and false returns so the
   * composer can keep the draft.
   */
  post: (
    config: StaffConfig,
    input: { resmanLeaseId: string; unitNumber?: string; body: string },
    author: { name: string; role: string },
  ) => Promise<boolean>;
}

let localSeq = 0;

/**
 * Stable empty thread. zustand v5 reads through useSyncExternalStore, which
 * compares the selector's result by reference — a selector ending in `?? []`
 * hands back a FRESH array every call, so React re-renders, re-selects, gets
 * another new array, and loops until "Maximum update depth exceeded". Selecting
 * this shared constant keeps the empty case referentially stable.
 */
export const EMPTY_THREAD: readonly LeaseNote[] = Object.freeze([]);

export const useLeaseNotes = create<LeaseNotesState>()((set, get) => ({
  byLease: {},
  loading: {},

  load: async (config, leaseId) => {
    if (get().loading[leaseId]) return;
    set((s) => ({ loading: { ...s.loading, [leaseId]: true } }));
    try {
      const notes = await fetchLeaseNotes(config, leaseId);
      set((s) => ({ byLease: { ...s.byLease, [leaseId]: notes } }));
    } catch {
      // Sheet shows the cached thread (possibly empty); the next open retries.
    } finally {
      set((s) => ({ loading: { ...s.loading, [leaseId]: false } }));
    }
  },

  post: async (config, input, author) => {
    const localId = `local-${++localSeq}`;
    const optimistic: LeaseNote = {
      id: localId,
      resmanLeaseId: input.resmanLeaseId,
      unitNumber: input.unitNumber ?? "",
      body: input.body,
      createdBy: author.name,
      createdByRole: author.role,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({
      byLease: {
        ...s.byLease,
        [input.resmanLeaseId]: [...(s.byLease[input.resmanLeaseId] ?? []), optimistic],
      },
    }));
    try {
      const saved = await createLeaseNote(config, input);
      set((s) => ({
        byLease: {
          ...s.byLease,
          [input.resmanLeaseId]: (s.byLease[input.resmanLeaseId] ?? []).map((n) =>
            n.id === localId ? saved : n,
          ),
        },
      }));
      return true;
    } catch {
      set((s) => ({
        byLease: {
          ...s.byLease,
          [input.resmanLeaseId]: (s.byLease[input.resmanLeaseId] ?? []).filter(
            (n) => n.id !== localId,
          ),
        },
      }));
      return false;
    }
  },
}));

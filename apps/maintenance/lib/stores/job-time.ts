import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
import { emptyEntry, type JobPart, type JobTimeEntry } from "@/lib/derived/job-time";

interface JobTimeState {
  /** Keyed by work-order id. */
  entries: Record<string, JobTimeEntry>;
  start: (workOrderId: string, nowMs?: number) => void;
  pause: (workOrderId: string, nowMs?: number) => void;
  /** Stop the clock and stamp the record as belonging to a closed job. */
  close: (workOrderId: string, nowMs?: number) => void;
  addPart: (workOrderId: string, name: string, quantity?: number) => void;
  setPartQuantity: (workOrderId: string, partId: string, quantity: number) => void;
  removePart: (workOrderId: string, partId: string) => void;
  /** Drop a record entirely — the tech's "start over", not a sync concern. */
  clear: (workOrderId: string) => void;
}

let partSeq = 0;
function partId(): string {
  partSeq += 1;
  return `p${Date.now().toString(36)}${partSeq.toString(36)}`;
}

/**
 * Time and parts per work order, on the device only.
 *
 * Nothing here reaches ResMan yet — there is no field for it until closed
 * work-order submission exists. So this store is deliberately NOT pruned when a
 * job closes: the record is stamped `closedAt` and kept, because it is the
 * evidence that will be submitted once there is somewhere to send it. Pruning
 * it on close would quietly throw away the only copy.
 *
 * Only one timer runs at a time. A tech is in one apartment; two clocks
 * running would both be wrong, and the one they forgot about would be worse.
 */
export const useJobTime = create<JobTimeState>()(
  persist(
    (set, get) => ({
      entries: {},

      start: (workOrderId, nowMs = Date.now()) =>
        set((s) => {
          const next: Record<string, JobTimeEntry> = {};
          for (const [id, entry] of Object.entries(s.entries)) {
            // Bank any other running clock before starting this one.
            next[id] =
              id !== workOrderId && entry.runningSince !== null
                ? {
                    ...entry,
                    accumulatedMs: entry.accumulatedMs + Math.max(0, nowMs - entry.runningSince),
                    runningSince: null,
                  }
                : entry;
          }
          const mine = next[workOrderId] ?? emptyEntry(workOrderId);
          next[workOrderId] = mine.runningSince !== null ? mine : { ...mine, runningSince: nowMs };
          return { entries: next };
        }),

      pause: (workOrderId, nowMs = Date.now()) =>
        set((s) => {
          const entry = s.entries[workOrderId];
          if (!entry || entry.runningSince === null) return s;
          return {
            entries: {
              ...s.entries,
              [workOrderId]: {
                ...entry,
                accumulatedMs: entry.accumulatedMs + Math.max(0, nowMs - entry.runningSince),
                runningSince: null,
              },
            },
          };
        }),

      close: (workOrderId, nowMs = Date.now()) =>
        set((s) => {
          const entry = s.entries[workOrderId];
          if (!entry) return s;
          const banked =
            entry.runningSince !== null
              ? entry.accumulatedMs + Math.max(0, nowMs - entry.runningSince)
              : entry.accumulatedMs;
          return {
            entries: {
              ...s.entries,
              [workOrderId]: { ...entry, accumulatedMs: banked, runningSince: null, closedAt: nowMs },
            },
          };
        }),

      addPart: (workOrderId, name, quantity = 1) =>
        set((s) => {
          const trimmed = name.trim();
          if (trimmed.length === 0) return s;
          const entry = s.entries[workOrderId] ?? emptyEntry(workOrderId);
          // Same part named twice bumps the quantity rather than listing it
          // twice — a tech reaching for a second washer means two washers.
          const existing = entry.parts.find((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase());
          const parts: JobPart[] = existing
            ? entry.parts.map((p) =>
                p.id === existing.id ? { ...p, quantity: p.quantity + Math.max(1, quantity) } : p,
              )
            : [...entry.parts, { id: partId(), name: trimmed, quantity: Math.max(1, quantity) }];
          return { entries: { ...s.entries, [workOrderId]: { ...entry, parts } } };
        }),

      setPartQuantity: (workOrderId, id, quantity) =>
        set((s) => {
          const entry = s.entries[workOrderId];
          if (!entry) return s;
          // Down to zero removes the line — that is what a tech means by it.
          const parts =
            quantity <= 0
              ? entry.parts.filter((p) => p.id !== id)
              : entry.parts.map((p) => (p.id === id ? { ...p, quantity } : p));
          return { entries: { ...s.entries, [workOrderId]: { ...entry, parts } } };
        }),

      removePart: (workOrderId, id) =>
        set((s) => {
          const entry = s.entries[workOrderId];
          if (!entry) return s;
          return {
            entries: {
              ...s.entries,
              [workOrderId]: { ...entry, parts: entry.parts.filter((p) => p.id !== id) },
            },
          };
        }),

      clear: (workOrderId) =>
        set((s) => {
          if (!s.entries[workOrderId]) return s;
          const next = { ...s.entries };
          delete next[workOrderId];
          return { entries: next };
        }),
    }),
    {
      name: "emberly-maintenance-job-time",
      storage: persistedStorage(),
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
);

/** Read without subscribing — for the close path, which needs a snapshot. */
export function jobTimeEntry(workOrderId: string): JobTimeEntry | undefined {
  return useJobTime.getState().entries[workOrderId];
}

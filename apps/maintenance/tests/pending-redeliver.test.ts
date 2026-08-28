import { describe, expect, mock, test } from "bun:test";

/**
 * The redeliver clock and the absorption compare — both field-found on a
 * ticket whose "Saved" pill flip-flopped back to "Pending sync" forever:
 * the redeliver window was measured from the entry's AGE (so anything older
 * than 30 minutes un-acked on every prune tick), and absorbed() compared
 * notes byte-for-byte while ResMan round-trips text with \r\n endings (so a
 * delivered multi-line note could never retire its entry).
 */

const store = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
}));
mock.module("@/lib/api/work-orders", () => ({
  editWorkOrder: async () => ({ ok: true, queued: false, stub: false }),
  closeWorkOrder: async () => ({ ok: true, queued: false, stub: false }),
}));

const { usePendingCloses } = await import("@/lib/stores/pending-closes");
const { usePendingEdits } = await import("@/lib/stores/pending-edits");

const NOW = 10_000_000_000;
const MIN = 60 * 1000;

describe("pending-closes redeliver clock", () => {
  test("a freshly re-acked old entry stays acked — no oscillation", async () => {
    usePendingCloses.setState({
      pending: {
        wo1: {
          workOrderId: "wo1",
          note: "",
          queuedAt: NOW - 5 * 60 * MIN, // entry is HOURS old…
          acked: true,
          ackedAt: NOW - 2 * MIN, // …but delivered two minutes ago
        },
      },
    });
    usePendingCloses.getState().prune(new Set(), NOW);
    expect(usePendingCloses.getState().pending.wo1.acked).toBe(true);
  });

  test("an ack older than the window redelivers; a stub-era ack (no ackedAt) redelivers immediately", () => {
    usePendingCloses.setState({
      pending: {
        stale: {
          workOrderId: "stale",
          note: "",
          queuedAt: NOW - 60 * MIN,
          acked: true,
          ackedAt: NOW - 45 * MIN,
        },
        stub: { workOrderId: "stub", note: "", queuedAt: NOW - 60 * MIN, acked: true },
      },
    });
    usePendingCloses.getState().prune(new Set(), NOW);
    expect(usePendingCloses.getState().pending.stale.acked).toBe(false);
    expect(usePendingCloses.getState().pending.stub.acked).toBe(false);
  });
});

describe("pending-edits absorption", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      resman_work_order_id: "wo1",
      notes: "",
      completion_notes: "",
      technician: "",
      date_scheduled: null,
      ...over,
    }) as never;

  test("CRLF round-tripped notes still absorb — the entry retires", () => {
    usePendingEdits.setState({
      pending: {
        wo1: {
          workOrderId: "wo1",
          patch: { completionNotes: "line one\nline two" },
          editedAt: NOW - 10 * MIN,
          acked: true,
          ackedAt: NOW - MIN,
        },
      },
    });
    usePendingEdits.getState().prune([row({ completion_notes: "line one\r\nline two\r\n" })], NOW);
    expect(usePendingEdits.getState().pending.wo1).toBeUndefined();
  });

  test("an Unassigned patch absorbs against the mirror's empty technician", () => {
    usePendingEdits.setState({
      pending: {
        wo1: {
          workOrderId: "wo1",
          patch: { technician: "Unassigned" },
          editedAt: NOW - 10 * MIN,
          acked: true,
          ackedAt: NOW - MIN,
        },
      },
    });
    usePendingEdits.getState().prune([row({ technician: "" })], NOW);
    expect(usePendingEdits.getState().pending.wo1).toBeUndefined();
  });

  test("genuinely different notes do NOT absorb, and a fresh ack holds", () => {
    usePendingEdits.setState({
      pending: {
        wo1: {
          workOrderId: "wo1",
          patch: { completionNotes: "the real note" },
          editedAt: NOW - 10 * MIN,
          acked: true,
          ackedAt: NOW - MIN,
        },
      },
    });
    usePendingEdits.getState().prune([row({ completion_notes: "something else" })], NOW);
    const entry = usePendingEdits.getState().pending.wo1;
    expect(entry).toBeDefined();
    expect(entry.acked).toBe(true); // fresh ack — no oscillation
  });
});

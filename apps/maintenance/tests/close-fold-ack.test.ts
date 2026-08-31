import { describe, expect, mock, test } from "bun:test";
import type { WorkOrderWriteRequest } from "@emberly/core";

/**
 * Coalesced close + pending edit: what the entry is acked WITH.
 *
 * closeWorkOrder folds a pending edit into the close so ResMan gets one form
 * replay, then acks the entry as delivered by that request. But the engine's
 * close writes its OWN note over folded typed notes (`patch.note` wins in
 * mutate()), so acking the entry with the draft that note superseded left it
 * holding a completionNotes ResMan never received: the mirror could never
 * absorb it, and half an hour later the redeliver clock un-acked the entry and
 * the next flush re-POSTed the stale draft OVER the close note — the "Saved"
 * pill sticking forever, plus real data loss in production ResMan.
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

const sent: WorkOrderWriteRequest[] = [];
/** Runs while the write is "in flight", so a test can type over the entry. */
let duringWrite: (() => void) | undefined;
mock.module("@/lib/resman/work-order-write", () => ({
  writeWorkOrderDirect: async (request: WorkOrderWriteRequest) => {
    sent.push(request);
    duringWrite?.();
    return { ok: true, phase: "verified", noop: false, detail: "verified" };
  },
}));

const { closeWorkOrder } = await import("@/lib/api/work-orders");
const { usePendingEdits } = await import("@/lib/stores/pending-edits");

const CONFIG = { baseUrl: "https://example.test", token: "t" } as never;
const NOW = 10_000_000_000;
const MIN = 60 * 1000;

const row = (over: Record<string, unknown>) =>
  ({
    resman_work_order_id: "wo1",
    notes: "",
    completion_notes: "",
    technician: "",
    date_scheduled: null,
    ...over,
  }) as never;

function seed(patch: Record<string, unknown>) {
  sent.length = 0;
  duringWrite = undefined;
  usePendingEdits.setState({
    pending: {
      wo1: { workOrderId: "wo1", patch, editedAt: NOW - 10 * MIN, acked: false },
    },
  });
}

describe("a close that carries its own note", () => {
  test("acks the folded edit with the note that WON, so the mirror can absorb it", async () => {
    seed({ completionNotes: "older draft" });
    await closeWorkOrder("wo1", "Final word", CONFIG);

    // The fold still happens — one ResMan update, both fields on it.
    expect(sent).toHaveLength(1);
    expect(sent[0].patch.note).toBe("Final word");
    expect(sent[0].patch.completionNotes).toBe("older draft");

    // …and the entry now holds what ResMan actually got. Holding "older
    // draft" here is the bug: it can never absorb, and redelivering it
    // overwrites the close note.
    const entry = usePendingEdits.getState().pending.wo1;
    expect(entry.acked).toBe(true);
    expect(entry.patch.completionNotes).toBe("Final word");

    // The mirror catches up (ResMan re-renders free text with CRLF) and the
    // entry retires instead of waiting out the redeliver clock.
    usePendingEdits.getState().prune([row({ completion_notes: "Final word\r\n" })], NOW + MIN);
    expect(usePendingEdits.getState().pending.wo1).toBeUndefined();
  });

  test("a note-less close leaves the folded typed notes alone — those DID land", async () => {
    seed({ completionNotes: "typed draft", technician: "Unassigned" });
    await closeWorkOrder("wo1", "", CONFIG);

    expect(sent[0].patch.note).toBeUndefined();
    const entry = usePendingEdits.getState().pending.wo1;
    expect(entry.acked).toBe(true);
    expect(entry.patch.completionNotes).toBe("typed draft");
    expect(entry.patch.technician).toBe("Unassigned");

    usePendingEdits.getState().prune([row({ completion_notes: "typed draft" })], NOW + MIN);
    expect(usePendingEdits.getState().pending.wo1).toBeUndefined();
  });

  test("a keystroke that lands mid-flight still blocks the ack — nothing is re-based", async () => {
    seed({ completionNotes: "older draft" });
    duringWrite = () => {
      usePendingEdits.setState({
        pending: {
          wo1: {
            workOrderId: "wo1",
            patch: { completionNotes: "newer draft" },
            editedAt: NOW,
            acked: false,
          },
        },
      });
    };
    await closeWorkOrder("wo1", "Final word", CONFIG);
    expect(sent[0].patch.completionNotes).toBe("older draft"); // what actually went
    const entry = usePendingEdits.getState().pending.wo1;
    expect(entry.acked).toBe(false); // flush retries it — it was never sent
    expect(entry.patch.completionNotes).toBe("newer draft");
  });
});

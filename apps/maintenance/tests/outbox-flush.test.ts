import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Two bugs in the outbox flush path, both of which need a slow request to show
 * themselves — which is exactly what a tech on bad property WiFi has.
 *
 * 1. NO RE-ENTRANCY GUARD. `flush()` is driven by the 60s sync tick AND by
 *    AppState going active. A request slower than the gap between those means
 *    two flushes overlap, each re-sending the same un-acked entries. Against a
 *    real ResMan write that is a work order closed twice.
 *
 * 2. BLIND ACK. `flush()` snapshots the entry, awaits the write, then marks
 *    `pending[id].acked = true` — the CURRENT entry, not the one it sent. If the
 *    tech kept typing or re-closed with a corrected note in the meantime, the
 *    newer value got marked accepted by a request that never carried it. And
 *    since `flush()` only ever retries un-acked entries, that correction was
 *    gone for good.
 */

// ── harness ────────────────────────────────────────────────────────────────

const store = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

mock.module("@/lib/analytics", () => ({
  capture: () => void (captures += 1),
  identify: () => {},
  resetAnalytics: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

let captures = 0;
/** Every write the store attempted, in order. */
let calls: Array<{ id: string; payload: string }> = [];
/** Resolvers for in-flight writes, so a test can hold one open. */
let gates: Array<() => void> = [];
/** When true, a write parks until the test releases it. */
let hold = false;

function record(id: string, payload: string): Promise<void> {
  calls.push({ id, payload });
  if (!hold) return Promise.resolve();
  return new Promise<void>((resolve) => gates.push(resolve));
}

mock.module("@/lib/api/work-orders", () => ({
  closeWorkOrder: (id: string, note: string) => record(id, note),
  editWorkOrder: (id: string, patch: Record<string, unknown>) => record(id, JSON.stringify(patch)),
}));

const config = { baseUrl: "https://example.test", token: "t" } as never;

function releaseAll(): void {
  const pending = gates;
  gates = [];
  for (const resolve of pending) resolve();
}

/** Yield to the microtask/timer queue so a parked flush can advance. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Let every started flush run to completion: stop parking new writes, release
 * the one already in flight, then await. Deterministic — no flush may be left
 * mid-loop, which would leave the module-scoped guard stuck for later tests.
 */
async function settle(promises: Array<Promise<unknown>>): Promise<void> {
  await tick();
  hold = false;
  releaseAll();
  await Promise.all(promises);
}

beforeEach(() => {
  store.clear();
  calls = [];
  gates = [];
  hold = false;
  captures = 0;
});

// ── pending closes ─────────────────────────────────────────────────────────

describe("pending closes — flush", () => {
  test("overlapping flushes send each un-acked close once", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    usePendingCloses.setState({
      pending: {
        "wo-1": { workOrderId: "wo-1", note: "valve replaced", queuedAt: 1, acked: false },
        "wo-2": { workOrderId: "wo-2", note: "reset breaker", queuedAt: 1, acked: false },
      },
    });

    hold = true;
    // The sync tick fires, then AppState goes active before the first write
    // has come back — the real sequence on a slow network.
    const first = usePendingCloses.getState().flush(config);
    const second = usePendingCloses.getState().flush(config);
    await settle([first, second]);

    // Two entries, two writes. Without the guard the second flush re-sent both.
    expect(calls.filter((c) => c.id === "wo-1")).toHaveLength(1);
    expect(calls.filter((c) => c.id === "wo-2")).toHaveLength(1);
  });

  test("a note corrected mid-flight is not marked accepted", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    usePendingCloses.setState({
      pending: {
        "wo-1": { workOrderId: "wo-1", note: "wrong unit", queuedAt: 1, acked: false, attempts: 1 },
      },
    });

    hold = true;
    const flushed = usePendingCloses.getState().flush(config);
    // The tech spots the mistake and re-closes with the real note while the
    // first request is still open.
    usePendingCloses.setState({
      pending: {
        "wo-1": { workOrderId: "wo-1", note: "0712 — mixing valve", queuedAt: 2, acked: false, attempts: 1 },
      },
    });
    await settle([flushed]);

    const entry = usePendingCloses.getState().pending["wo-1"];
    expect(entry.note).toBe("0712 — mixing valve");
    // Still queued, so the next tick sends the correction.
    expect(entry.acked).toBe(false);
    // And the analytics event belongs to the attempt that actually lands.
    expect(captures).toBe(0);

    await usePendingCloses.getState().flush(config);
    expect(calls.at(-1)).toEqual({ id: "wo-1", payload: "0712 — mixing valve" });
    expect(usePendingCloses.getState().pending["wo-1"].acked).toBe(true);
  });

  test("an unchanged close still acks", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    usePendingCloses.setState({
      pending: { "wo-3": { workOrderId: "wo-3", note: "done", queuedAt: 1, acked: false } },
    });
    await usePendingCloses.getState().flush(config);
    expect(usePendingCloses.getState().pending["wo-3"].acked).toBe(true);
    expect(captures).toBe(1);
  });
});

// ── pending edits ──────────────────────────────────────────────────────────

describe("pending edits — flush", () => {
  test("overlapping flushes send each un-acked edit once", async () => {
    const { usePendingEdits } = await import("@/lib/stores/pending-edits");
    usePendingEdits.setState({
      pending: {
        "wo-1": { workOrderId: "wo-1", patch: { technician: "R. Diaz" }, editedAt: 1, acked: false },
      },
    });

    hold = true;
    const first = usePendingEdits.getState().flush(config);
    const second = usePendingEdits.getState().flush(config);
    await settle([first, second]);

    expect(calls.filter((c) => c.id === "wo-1")).toHaveLength(1);
  });

  test("keystrokes landing mid-flight are not marked accepted", async () => {
    const { usePendingEdits } = await import("@/lib/stores/pending-edits");
    usePendingEdits.setState({
      pending: {
        "wo-1": {
          workOrderId: "wo-1",
          patch: { completionNotes: "Replaced the" },
          editedAt: 1,
          acked: false,
        },
      },
    });

    hold = true;
    const flushed = usePendingEdits.getState().flush(config);
    // The tech finishes the sentence while the PATCH is in flight.
    usePendingEdits.setState({
      pending: {
        "wo-1": {
          workOrderId: "wo-1",
          patch: { completionNotes: "Replaced the mixing valve and flushed the line" },
          editedAt: 2,
          acked: false,
        },
      },
    });
    await settle([flushed]);

    const entry = usePendingEdits.getState().pending["wo-1"];
    expect(entry.patch.completionNotes).toBe("Replaced the mixing valve and flushed the line");
    expect(entry.acked).toBe(false);

    await usePendingEdits.getState().flush(config);
    expect(usePendingEdits.getState().pending["wo-1"].acked).toBe(true);
  });

  test("key order alone does not make an unchanged patch look changed", async () => {
    const { usePendingEdits } = await import("@/lib/stores/pending-edits");
    usePendingEdits.setState({
      pending: {
        "wo-2": {
          workOrderId: "wo-2",
          patch: { technician: "R. Diaz", description: "Leak" },
          editedAt: 1,
          acked: false,
        },
      },
    });

    hold = true;
    const flushed = usePendingEdits.getState().flush(config);
    // Same edit, rebuilt with the keys the other way round — a re-merge in
    // queueEdit can do exactly this. It must still ack.
    usePendingEdits.setState({
      pending: {
        "wo-2": {
          workOrderId: "wo-2",
          patch: { description: "Leak", technician: "R. Diaz" },
          editedAt: 1,
          acked: false,
        },
      },
    });
    await settle([flushed]);

    expect(usePendingEdits.getState().pending["wo-2"].acked).toBe(true);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { WorkOrderWriteRefused } from "@emberly/core";

/**
 * The device's pending writes, applied to the mirror for EVERY screen.
 *
 * Field-reported: reassigning a technician showed on the detail screen and
 * nowhere else. The overlay lived only in that screen, so the board, My Day and
 * every filter kept the old assignee until the server's next scrape. A close
 * did the same on the Open board. And three sync-queue holes sat behind it: a
 * REFUSED close was acked as delivered, a verified write could be redelivered
 * over the office's newer change, and a date-only edit read "Marked complete".
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
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

/** What the mocked close answers with — resolve, or a scripted refusal. */
let closeVerdict: () => Promise<unknown> = async () => ({ ok: true });
let closeCalls = 0;
mock.module("@/lib/api/work-orders", () => ({
  listWorkOrders: async () => ({ data: [], pagination: { hasMore: false, count: 0 } }),
  editWorkOrder: async () => ({ ok: true, queued: false, stub: false }),
  closeWorkOrder: async () => {
    closeCalls += 1;
    return closeVerdict();
  },
}));

const { applyPendingOverlay, localDateString, overlaySignature } = await import(
  "@/lib/derived/pending-overlay"
);
const { overlaidWorkOrders } = await import("@/lib/hooks/use-overlaid-work-orders");
const { usePendingCloses } = await import("@/lib/stores/pending-closes");
const { usePendingEdits } = await import("@/lib/stores/pending-edits");
const { buildOutbox, editFields } = await import("@/lib/derived/outbox");

type Row = Parameters<typeof applyPendingOverlay>[0][number];
type Edits = Parameters<typeof applyPendingOverlay>[1];
type Closes = Parameters<typeof applyPendingOverlay>[2];

const row = (id: string, over: Partial<Row> = {}): Row =>
  ({
    resman_work_order_id: id,
    status: "In Progress",
    technician: "Sam Ortiz",
    notes: "Leaking sink",
    completion_notes: "",
    date_scheduled: null,
    date_completed: null,
    synced_at: null,
    ...over,
  }) as Row;

const edit = (id: string, patch: Edits[string]["patch"], over: Partial<Edits[string]> = {}) => ({
  [id]: { workOrderId: id, patch, editedAt: 1, acked: false, ...over },
});

const close = (id: string, over: Partial<Closes[string]> = {}) => ({
  [id]: { workOrderId: id, note: "", queuedAt: new Date(2026, 8, 23, 10).getTime(), acked: false, ...over },
});

const config = { baseUrl: "https://example.test", token: "t" } as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store.clear();
  closeCalls = 0;
  closeVerdict = async () => ({ ok: true });
  usePendingCloses.setState({ pending: {} });
  usePendingEdits.setState({ pending: {} });
});

// ── the overlay itself ─────────────────────────────────────────────────────

describe("applyPendingOverlay", () => {
  test("a reassignment shows on every row the engine sees, not just the detail screen", () => {
    const rows = [row("a"), row("b")];
    const out = applyPendingOverlay(rows, edit("a", { technician: "Quintez Harden" }), {});
    expect(out[0].technician).toBe("Quintez Harden");
    expect(out[1]).toBe(rows[1]); // untouched rows keep their identity
  });

  test("reassigning to Unassigned clears the technician the way the mirror spells it", () => {
    const out = applyPendingOverlay([row("a")], edit("a", { technician: "Unassigned" }), {});
    expect(out[0].technician).toBe("");
  });

  test("a queued close reads as Completed on the day it was finished", () => {
    const finished = new Date(2026, 8, 21, 16, 30).getTime();
    const out = applyPendingOverlay([row("a")], {}, close("a", { completedAt: finished, note: "Done" }));
    expect(out[0].status).toBe("Completed");
    expect(out[0].date_completed).toBe("2026-09-21");
    expect(out[0].completion_notes).toBe("Done");
  });

  test("a scheduled date lands date-only, like the mirror column", () => {
    const picked = new Date(2026, 8, 24, 19, 30).toISOString();
    const out = applyPendingOverlay([row("a")], edit("a", { scheduledAt: picked }), {});
    expect(out[0].date_scheduled).toBe("2026-09-24");
    const cleared = applyPendingOverlay([row("a", { date_scheduled: "2026-09-01" })], edit("a", { scheduledAt: null }), {});
    expect(cleared[0].date_scheduled).toBeNull();
  });

  test("writes ResMan REFUSED are not painted as real", () => {
    const rows = [row("a"), row("b")];
    const out = applyPendingOverlay(
      rows,
      edit("a", { technician: "Quintez Harden" }, { blockedReason: "locked" }),
      close("b", { blockedReason: "work order is Canceled" }),
    );
    expect(out).toBe(rows);
  });

  test("no pending writes returns the mirror array itself", () => {
    const rows = [row("a")];
    expect(applyPendingOverlay(rows, {}, {})).toBe(rows);
  });

  test("the same row under the same overlay is the same object — the parser's caches keep hitting", () => {
    const rows = [row("a")];
    const edits = edit("a", { technician: "Quintez Harden" });
    expect(applyPendingOverlay(rows, edits, {})[0]).toBe(applyPendingOverlay(rows, edits, {})[0]);
  });
});

describe("overlaidWorkOrders — the version every screen parses against", () => {
  test("moves when the overlay moves, even though the mirror did not", () => {
    const rows = [row("a")];
    const before = overlaidWorkOrders(rows, {}, {});
    const after = overlaidWorkOrders(rows, edit("a", { technician: "Quintez Harden" }), {});
    expect(after.dataVersion).not.toBe(before.dataVersion);
    expect(after.workOrders[0].technician).toBe("Quintez Harden");
  });

  test("holds still when only delivery bookkeeping changes (ack, error, retry)", () => {
    const rows = [row("a")];
    const queued = overlaidWorkOrders(rows, edit("a", { technician: "Quintez Harden" }), {});
    const acked = overlaidWorkOrders(
      rows,
      edit("a", { technician: "Quintez Harden" }, { acked: true, ackedAt: 5, lastError: "x" }),
      {},
    );
    expect(acked.dataVersion).toBe(queued.dataVersion);
    expect(acked.workOrders).toBe(queued.workOrders);
  });

  test("two callers with the same inputs get the identical array — no cache thrash", () => {
    const rows = [row("a")];
    const edits = edit("a", { technician: "Quintez Harden" });
    expect(overlaidWorkOrders(rows, edits, {})).toEqual(overlaidWorkOrders(rows, edits, {}));
    expect(overlaidWorkOrders(rows, edits, {}).workOrders).toBe(
      overlaidWorkOrders(rows, edits, {}).workOrders,
    );
  });

  test("the signature ignores key order", () => {
    const a = edit("a", { technician: "X", description: "Y" });
    const b = edit("a", { description: "Y", technician: "X" });
    expect(overlaySignature(a, {})).toBe(overlaySignature(b, {}));
  });
});

// ── a refused close is blocked, never acked ────────────────────────────────

describe("a close ResMan refuses", () => {
  test("goes BLOCKED with the reason instead of being acked as delivered", async () => {
    closeVerdict = async () => {
      throw new WorkOrderWriteRefused("work order is Canceled");
    };
    await usePendingCloses.getState().queueClose("a", "Done", config);
    const entry = usePendingCloses.getState().pending.a;
    expect(entry.acked).toBe(false);
    expect(entry.blockedReason).toContain("Canceled");
  });

  test("the automatic flush leaves it alone; a manual Sync now asks once more", async () => {
    usePendingCloses.setState({ pending: close("a", { blockedReason: "locked" }) });
    await usePendingCloses.getState().flush(config);
    expect(closeCalls).toBe(0);
    await usePendingCloses.getState().flush(config, { includeBlocked: true });
    expect(closeCalls).toBe(1);
    // It landed this time — acked, and no longer blocked.
    expect(usePendingCloses.getState().pending.a.acked).toBe(true);
    expect(usePendingCloses.getState().pending.a.blockedReason).toBeUndefined();
  });

  test("a transport failure puts it back on the automatic clock", async () => {
    usePendingCloses.setState({ pending: close("a", { blockedReason: "locked" }) });
    closeVerdict = async () => {
      throw new Error("offline");
    };
    await usePendingCloses.getState().flush(config, { includeBlocked: true });
    const entry = usePendingCloses.getState().pending.a;
    expect(entry.blockedReason).toBeUndefined();
    expect(entry.lastError).toBe("offline");
  });

  test("leads the outbox as blocked, with ResMan's reason on the row", () => {
    const items = buildOutbox({
      closes: Object.values(close("a", { blockedReason: "work order is Canceled" })),
      edits: [],
      photos: {},
      photosSyncing: false,
    });
    expect(items[0].state).toBe("blocked");
    expect(items[0].lastError).toBe("work order is Canceled");
  });

  test("a re-close with a corrected note in flight is not blocked by the older verdict", async () => {
    let release!: () => void;
    closeVerdict = () =>
      new Promise((_, reject) => {
        release = () => reject(new WorkOrderWriteRefused("bad completedAt"));
      });
    const first = usePendingCloses.getState().queueClose("a", "first", config);
    await tick();
    // The tech corrects the note while the first request is still out.
    usePendingCloses.setState({ pending: close("a", { note: "second" }) });
    release();
    await first;
    expect(usePendingCloses.getState().pending.a.blockedReason).toBeUndefined();
  });
});

// ── never redeliver over someone else's newer change ───────────────────────

describe("redelivery stands down once the mirror has looked", () => {
  const NOW = 10_000_000_000;
  const MIN = 60_000;
  /** Acked `mins` ago, edited just before — well inside the stale window, so
   *  nothing here can pass by simply aging out. */
  const fresh = (mins: number) => ({
    acked: true,
    ackedAt: NOW - mins * MIN,
    editedAt: NOW - (mins + 1) * MIN,
  });

  test("an acked edit the office overwrote since retires instead of being re-written", () => {
    usePendingEdits.setState({
      pending: edit("a", { technician: "Quintez Harden" }, fresh(40)),
    });
    // Scraped 20 minutes AFTER our verified write, and it still says Sam: the
    // office reassigned it back. Redelivering would silently undo them.
    const scraped = new Date(NOW - 20 * MIN).toISOString();
    usePendingEdits.getState().prune([row("a", { synced_at: scraped })], NOW);
    expect(usePendingEdits.getState().pending.a).toBeUndefined();
  });

  test("an acked edit the mirror has NOT looked at since still redelivers", () => {
    usePendingEdits.setState({
      pending: edit("a", { technician: "Quintez Harden" }, fresh(40)),
    });
    const scraped = new Date(NOW - 45 * MIN).toISOString(); // before the ack
    usePendingEdits.getState().prune([row("a", { synced_at: scraped })], NOW);
    expect(usePendingEdits.getState().pending.a.acked).toBe(false);
  });

  test("a scrape inside the skew window is not taken as the office's word", () => {
    usePendingEdits.setState({
      pending: edit("a", { technician: "Quintez Harden" }, fresh(5)),
    });
    // Stamped one minute after the ack — it may have READ ResMan before our write.
    const scraped = new Date(NOW - 4 * MIN).toISOString();
    usePendingEdits.getState().prune([row("a", { synced_at: scraped })], NOW);
    expect(usePendingEdits.getState().pending.a).toBeDefined();
  });

  test("an acked close the office reopened retires instead of being re-closed", () => {
    usePendingCloses.setState({
      pending: close("a", { acked: true, ackedAt: NOW - 40 * MIN, queuedAt: NOW - 41 * MIN }),
    });
    usePendingCloses.getState().prune(new Set(), NOW, new Map([["a", NOW - 20 * MIN]]));
    expect(usePendingCloses.getState().pending.a).toBeUndefined();
  });

  test("an acked close the mirror has not re-scraped still redelivers", () => {
    usePendingCloses.setState({
      pending: close("a", { acked: true, ackedAt: NOW - 40 * MIN, queuedAt: NOW - 41 * MIN }),
    });
    usePendingCloses.getState().prune(new Set(), NOW, new Map([["a", NOW - 50 * MIN]]));
    expect(usePendingCloses.getState().pending.a.acked).toBe(false);
  });
});

// ── the outbox names what changed ──────────────────────────────────────────

describe("outbox labels", () => {
  test("a date-only edit says schedule, not Marked complete", () => {
    expect(editFields({ scheduledAt: "2026-09-24T19:30:00.000Z" })).toEqual(["schedule"]);
  });
});

test("localDateString is the local calendar day", () => {
  expect(localDateString(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
});

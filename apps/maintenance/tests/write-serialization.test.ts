import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  WorkOrderWriteRefused,
  type WorkOrderWriteRequest,
  type WorkOrderWriteResult,
} from "@emberly/core";

/**
 * Two ways the direct write path lied about what reached ResMan.
 *
 * 1. FALSE ACK ON A CLOSE THAT WROTE NOTHING. `closeWorkOrder` folds a pending
 *    EDIT (typed completion notes, a reassignment) into the close so ResMan
 *    gets one update, then acked that edit whenever the close did not throw.
 *    A guard refusal never POSTs, and a no-op close on a work order the office
 *    already Closed returns before the folded fields are applied at all — both
 *    acked an edit that was never written, and `flush()` only retries UN-acked
 *    entries, so the tech's typed notes were gone for good behind a green
 *    "Saved" pill.
 *
 * 2. SAME-TICKET WRITE RACE. A direct write is a read-modify-write over a ~48
 *    control form. The close flush and the edit flush are launched un-awaited
 *    off the same sync tick, so both harvested the same pre-write form and the
 *    later POST — carrying the whole form as it looked BEFORE the other write
 *    — reverted it (the close set Status=Completed; the edit put "Not Started"
 *    back).
 */

// ── harness ────────────────────────────────────────────────────────────────

const secure = new Map<string, string>();
mock.module("expo-secure-store", () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
  deleteItemAsync: async (k: string) => void secure.delete(k),
}));
const asyncStore = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => asyncStore.get(k) ?? null,
    setItem: async (k: string, v: string) => void asyncStore.set(k, v),
    removeItem: async (k: string) => void asyncStore.delete(k),
  },
}));
mock.module("@react-native-cookies/cookies", () => ({
  default: { set: async () => true, clearAll: async () => true },
}));
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
}));

// The REAL direct writer, captured before the module is mocked below:
// mock.module is file-global, and the serialization half of this file must
// drive the genuine harvest → POST → verify cycle while the ack half needs
// `closeWorkOrder` to see scripted verdicts. Destructuring copies the real
// function, so the mock cannot reach it.
const { writeWorkOrderDirect } = await import("@/lib/resman/work-order-write");
const { useResManSession } = await import("@/lib/resman/session");

/** What the mocked writer answers `closeWorkOrder` with. */
let scripted: (request: WorkOrderWriteRequest) => Promise<WorkOrderWriteResult> = async () => {
  throw new Error("no verdict scripted");
};
/** Every request the mocked writer saw, in order. */
let scriptedCalls: WorkOrderWriteRequest[] = [];
mock.module("@/lib/resman/work-order-write", () => ({
  writeWorkOrderDirect: (request: WorkOrderWriteRequest) => {
    scriptedCalls.push(request);
    return scripted(request);
  },
}));

const { closeWorkOrder } = await import("@/lib/api/work-orders");
const { usePendingEdits } = await import("@/lib/stores/pending-edits");

const config = { baseUrl: "https://example.test", token: "t" } as never;

const FIXTURES = path.join(__dirname, "..", "..", "..", "supabase", "sync", "tests", "fixtures");
const fixture = (name: string) =>
  readFileSync(path.join(FIXTURES, `work-order-edit-${name}.html`), "utf8");

const BASE = "https://multisouth.myresman.com";
/** 16305 and 16376 — two different work orders, real captured edit pages. */
const WO_A = "6f09851a-df4e-488f-a86b-de4a60bd4225";
const WO_B = "d1737525-2f29-4608-a9c6-7d579e23feb0";
const FIXTURE_OF: Record<string, string> = { [WO_A]: "16305", [WO_B]: "16376" };

/** Yield to the timer queue so a parked write could advance if it wanted to. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── 1. the folded edit's ack ───────────────────────────────────────────────

const FOLDED = { completionNotes: "Replaced the wax ring, tested twice" };

function seedPendingEdit(): void {
  usePendingEdits.setState({
    pending: {
      [WO_A]: { workOrderId: WO_A, patch: FOLDED, editedAt: Date.now(), acked: false },
    },
  });
}

describe("closeWorkOrder acks the folded edit only when it was delivered", () => {
  beforeEach(() => {
    scriptedCalls = [];
    seedPendingEdit();
  });

  test("a REFUSED close leaves the pending edit un-acked", async () => {
    scripted = async () => {
      throw new WorkOrderWriteRefused("Description is locked by ResMan on this work order");
    };
    await closeWorkOrder(WO_A, "Done", config);
    // The close folded the edit in (so the loss is real if it acks)…
    expect(scriptedCalls[0].patch.completionNotes).toBe(FOLDED.completionNotes);
    // …but nothing was POSTed, so the edit must still be waiting for its own
    // flush rather than sitting acked and forgotten.
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(false);
  });

  test("a NO-OP close leaves the pending edit un-acked", async () => {
    // The engine plans zero changes and reports success — but on a work order
    // the office already Closed it bails before applying the folded fields.
    scripted = async () => ({ ok: true, phase: "verified", noop: true, detail: "already applied" });
    await closeWorkOrder(WO_A, "Done", config);
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(false);
  });

  test("a VERIFIED close acks the folded edit", async () => {
    scripted = async () => ({
      ok: true,
      phase: "verified",
      noop: false,
      postStatus: 200,
      detail: "verified",
    });
    await closeWorkOrder(WO_A, "Done", config);
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(true);
  });

  test("an un-acked edit converges: the retry that no-ops acks it", async () => {
    // Un-acked is not un-ending. The edit's own flush re-sends it; once the
    // values are in ResMan that write no-ops as ok and the entry retires.
    scripted = async () => ({ ok: true, phase: "verified", noop: true, detail: "already applied" });
    await closeWorkOrder(WO_A, "Done", config);
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(false);
    await usePendingEdits.getState().flush(config);
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(true);
    expect(scriptedCalls[1].kind).toBe("edit");
  });
});

// ── 2. per-work-order serialization ────────────────────────────────────────

/** Wire traffic in order, as "<label> <method>". */
let events: string[] = [];
/** In-memory ResMan: the CompletedNotes each work order currently holds. */
let notes = new Map<string, string>();

function pageFor(id: string): string {
  return fixture(FIXTURE_OF[id]).replace(
    /(id="CompletedNotes" name="CompletedNotes" rows="2">)[\s\S]*?(<\/textarea>)/,
    (_all, open: string, close: string) => `${open}\n${notes.get(id) ?? ""}${close}`,
  );
}

function response(url: string, body: string): Response {
  return { url, status: 200, text: async () => body } as unknown as Response;
}

/**
 * RN-flavored transport for one write: the POST's redirect is auto-followed,
 * and the note it carried becomes the page every later GET reads.
 */
function transport(
  label: string,
  opts: { holdPost?: Promise<void>; onPost?: () => void } = {},
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const id = url.slice(url.lastIndexOf("/") + 1);
    events.push(`${label} ${method}`);
    if (method === "POST") {
      notes.set(id, new URLSearchParams(init?.body as string).get("CompletedNotes") ?? "");
      opts.onPost?.();
      if (opts.holdPost) await opts.holdPost;
      return response(`${BASE}/WorkOrders`, "<html>list</html>");
    }
    return response(url, pageFor(id));
  }) as unknown as typeof fetch;
}

function noteEdit(id: string, note: string): WorkOrderWriteRequest {
  return { workOrderId: id, kind: "edit", patch: { completionNotes: note }, expectedUnitId: null };
}

/** A gate the test opens by hand, plus a promise that fires when it is hit. */
function gate(): {
  held: Promise<void>;
  reached: Promise<void>;
  open: () => void;
  hit: () => void;
} {
  let open!: () => void;
  let hit!: () => void;
  const held = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (hit = resolve));
  return { held, reached, open, hit };
}

describe("writeWorkOrderDirect serializes per work order", () => {
  beforeEach(() => {
    events = [];
    notes = new Map([
      [WO_A, ""],
      [WO_B, "Test tin"],
    ]);
    useResManSession.setState({ status: "active", username: "tech", hydrated: true });
  });

  test("a second write to the SAME work order waits for the first cycle", async () => {
    const first = gate();
    const a = writeWorkOrderDirect(
      noteEdit(WO_A, "First note"),
      transport("A", { holdPost: first.held, onPost: first.hit }),
    );
    await first.reached;
    const b = writeWorkOrderDirect(noteEdit(WO_A, "Second note"), transport("B"));
    await tick();
    await tick();
    // B has not even harvested: it would otherwise capture the pre-write form
    // and later POST the whole thing back over A's save.
    expect(events).toEqual(["A GET", "A POST"]);

    first.open();
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    // Harvest → POST → verify, twice, never interleaved.
    expect(events).toEqual(["A GET", "A POST", "A GET", "B GET", "B POST", "B GET"]);
    // B re-harvested after A landed, so the last write is the one that stands.
    expect(notes.get(WO_A)).toBe("Second note");
  });

  test("writes to DIFFERENT work orders still overlap", async () => {
    const first = gate();
    const a = writeWorkOrderDirect(
      noteEdit(WO_A, "First note"),
      transport("A", { holdPost: first.held, onPost: first.hit }),
    );
    await first.reached;
    const b = writeWorkOrderDirect(noteEdit(WO_B, "Other ticket"), transport("B"));
    // B must finish while A is still parked mid-POST — a global lock would
    // stall a tech flushing a day's worth of jobs.
    const raced = await Promise.race([
      b.then(() => "finished"),
      tick()
        .then(() => tick())
        .then(() => "blocked"),
    ]);
    expect(raced).toBe("finished");
    expect(events.slice(0, 2)).toEqual(["A GET", "A POST"]);

    first.open();
    expect((await a).ok).toBe(true);
    expect(notes.get(WO_B)).toBe("Other ticket");
  });

  test("a throwing write releases the lock", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(writeWorkOrderDirect(noteEdit(WO_A, "Nope"), boom)).rejects.toThrow("offline");
    // The next write must not be queued behind a hold that was never released.
    const after = await writeWorkOrderDirect(noteEdit(WO_A, "After"), transport("A"));
    expect(after.ok).toBe(true);
  });
});

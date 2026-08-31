import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  WorkOrderWriteRefused,
  type WorkOrderWriteRequest,
  type WorkOrderWriteResult,
} from "@emberly/core";
import { buildOutbox } from "@/lib/derived/outbox";

/**
 * Two ways the direct write path lied about what reached ResMan.
 *
 * 1. AN EDIT REPORTED AS DELIVERED THAT NEVER REACHED RESMAN. Two doors led to
 *    the same room. `closeWorkOrder` folds a pending EDIT (typed completion
 *    notes, a reassignment) into the close, then acked that edit whenever the
 *    close did not throw — including a guard refusal (nothing POSTed) and a
 *    no-op close on a work order the office already Closed (the engine returns
 *    BEFORE applying the folded fields). And `editWorkOrder` itself reported a
 *    refusal as `ok`, so the edit's OWN flush acked it too. Since `flush()`
 *    only retries UN-acked entries, the tech's typed notes were gone for good
 *    behind a green "Delivered" pill.
 *
 *    The invariant these tests pin: `acked` means the values are VERIFIED in
 *    ResMan and nothing else. A refusal is terminal but undelivered — it
 *    marks the entry BLOCKED, which stops the retries AND keeps the row in the
 *    outbox carrying ResMan's reason.
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

  // The other two termination paths — the ones where the notes really are NOT
  // in ResMan. Leaving the close's ack un-acked only defers the loss unless
  // the edit's own retry refuses to call a refusal a delivery, which is the
  // whole point of `blockedReason`.

  test("the same refusal on the edit's own retry BLOCKS it — it is never acked", async () => {
    const LOCKED = "Description is locked by ResMan on this work order";
    scripted = async () => {
      throw new WorkOrderWriteRefused(LOCKED);
    };
    await closeWorkOrder(WO_A, "Done", config);
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(false);

    // The sync tick re-sends the merged patch as its own edit. Same guard,
    // same verdict — and THIS is where the old code called it delivered.
    await usePendingEdits.getState().flush(config);
    const entry = usePendingEdits.getState().pending[WO_A];
    expect(scriptedCalls.map((c) => c.kind)).toEqual(["close", "edit"]);
    expect(entry.acked).toBe(false);
    expect(entry.blockedReason).toBe(LOCKED);

    // Terminal, and VISIBLE: the tech's notes are still on the phone, the row
    // is still in the outbox, and it says why.
    const [item] = buildOutbox({ closes: [], edits: [entry], photos: {}, photosSyncing: false });
    expect(item.state).toBe("blocked");
    expect(item.lastError).toBe(LOCKED);

    // Terminal means terminal: the next tick does not re-send it.
    await usePendingEdits.getState().flush(config);
    expect(scriptedCalls).toHaveLength(2);
  });

  test("an office-Closed ticket: no-op close, then the retry blocks on the close guard", async () => {
    const OFFICE = "work order is Closed — edits after close are office work";
    scripted = async (request) => {
      // The close returns before applying the folded fields; the edit that
      // follows is refused outright by preflight.
      if (request.kind === "close") {
        return { ok: true, phase: "verified", noop: true, detail: "already applied" };
      }
      throw new WorkOrderWriteRefused(OFFICE);
    };
    await closeWorkOrder(WO_A, "Done", config);
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(false);
    await usePendingEdits.getState().flush(config);
    const entry = usePendingEdits.getState().pending[WO_A];
    expect(entry.acked).toBe(false);
    expect(entry.blockedReason).toBe(OFFICE);
  });

  test("queueEdit blocks on a refusal rather than acking it", async () => {
    // The earliest door into the same room: the edit is refused on the very
    // first attempt, before any close exists.
    const LOCKED = "Description is locked by ResMan on this work order";
    usePendingEdits.setState({ pending: {} });
    scripted = async () => {
      throw new WorkOrderWriteRefused(LOCKED);
    };
    await usePendingEdits.getState().queueEdit(WO_A, FOLDED, config);
    const entry = usePendingEdits.getState().pending[WO_A];
    expect(entry.acked).toBe(false);
    expect(entry.blockedReason).toBe(LOCKED);
  });

  test("a transport failure is NOT a refusal — the entry stays on the retry clock", async () => {
    // The roster endpoint being unreachable used to be dressed up as a guard
    // verdict. Blocking on it would strand an edit that merely needs signal.
    scripted = async () => {
      throw new Error("employee list unreachable — will retry");
    };
    await usePendingEdits.getState().flush(config);
    const stuck = usePendingEdits.getState().pending[WO_A];
    expect(stuck.blockedReason).toBeUndefined();
    expect(stuck.lastError).toBe("employee list unreachable — will retry");

    scripted = async () => ({
      ok: true,
      phase: "verified",
      noop: false,
      postStatus: 200,
      detail: "verified",
    });
    await usePendingEdits.getState().flush(config);
    expect(usePendingEdits.getState().pending[WO_A].acked).toBe(true);
  });

  test("the automatic flush skips a blocked entry; a manual Sync now retries it", async () => {
    scripted = async () => {
      throw new WorkOrderWriteRefused("work order is Closed — edits after close are office work");
    };
    await usePendingEdits.getState().flush(config);
    expect(usePendingEdits.getState().pending[WO_A].blockedReason).toBeDefined();
    await usePendingEdits.getState().flush(config);
    expect(scriptedCalls).toHaveLength(1); // the tick did not re-send it

    // The office reopened the ticket and the tech taps "Sync now".
    scripted = async () => ({
      ok: true,
      phase: "verified",
      noop: false,
      postStatus: 200,
      detail: "verified",
    });
    await usePendingEdits.getState().flush(config, { includeBlocked: true });
    const entry = usePendingEdits.getState().pending[WO_A];
    expect(scriptedCalls).toHaveLength(2);
    expect(entry.acked).toBe(true);
    expect(entry.blockedReason).toBeUndefined();
  });
});

// ── 2. per-work-order serialization ────────────────────────────────────────

/** Wire traffic in order, as "<label> <method>". */
let events: string[] = [];

/**
 * In-memory ResMan. It has to model STATUS, not just the notes textarea: the
 * corruption this half is about is a stale full-form POST putting Status back
 * to "Not Started" over a close that set it to "Completed". A fake that only
 * remembers CompletedNotes cannot see that happen at all.
 */
interface StoredWorkOrder {
  notes: string;
  status: string;
  completedDate: string;
  completedDateDate: string;
  completedBy: string;
}
let resman = new Map<string, StoredWorkOrder>();

const blank = (): StoredWorkOrder => ({
  notes: "",
  status: "Not Started",
  completedDate: "",
  completedDateDate: "",
  completedBy: "",
});

/** Re-render the captured edit page with the values ResMan currently holds. */
function pageFor(id: string): string {
  const row = resman.get(id) ?? blank();
  return fixture(FIXTURE_OF[id])
    .replace(
      /(id="CompletedNotes" name="CompletedNotes" rows="2">)[\s\S]*?(<\/textarea>)/,
      (_all, open: string, close: string) => `${open}\n${row.notes}${close}`,
    )
    .replace(
      /(<select[^>]*id="Status"[^>]*>)([\s\S]*?)(<\/select>)/,
      (_all, open: string, body: string, close: string) => {
        // Move `selected` onto the option ResMan would render selected.
        const options = body.replace(
          /<option(?: selected="selected")?>([^<]*)<\/option>/g,
          (_o, text: string) =>
            `<option${text === row.status ? ' selected="selected"' : ""}>${text}</option>`,
        );
        return `${open}${options}${close}`;
      },
    )
    .replace(
      /(id="CompletedDate" name="CompletedDate" type="hidden" value=")[^"]*(")/,
      `$1${row.completedDate}$2`,
    )
    .replace(
      /(id="CompletedDate_Date" name="CompletedDate_Date" type="text" value=")[^"]*(")/,
      `$1${row.completedDateDate}$2`,
    )
    .replace(
      /(<select data-selected-value=")[^"]*("[^>]*id="CompletedByPersonID")/,
      `$1${row.completedBy}$2`,
    );
}

function response(url: string, body: string): Response {
  return { url, status: 200, text: async () => body } as unknown as Response;
}

/**
 * RN-flavored transport for one write: the POST's redirect is auto-followed,
 * and the fields it carried become the page every later GET reads.
 *
 * The posted values are applied AFTER `holdPost` resolves, not before — a
 * write lands when the request completes. Applying them at the moment the POST
 * is issued would let a "concurrent" write harvest the parked write's result
 * and quietly hide every race this file exists to catch.
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
      const posted = new URLSearchParams(init?.body as string);
      opts.onPost?.();
      if (opts.holdPost) await opts.holdPost;
      resman.set(id, {
        notes: posted.get("CompletedNotes") ?? "",
        status: posted.get("Status") ?? "",
        completedDate: posted.get("CompletedDate") ?? "",
        completedDateDate: posted.get("CompletedDate_Date") ?? "",
        completedBy: posted.get("CompletedByPersonID") ?? "",
      });
      return response(`${BASE}/WorkOrders`, "<html>list</html>");
    }
    return response(url, pageFor(id));
  }) as unknown as typeof fetch;
}

function closeWrite(id: string, note: string): WorkOrderWriteRequest {
  return { workOrderId: id, kind: "close", patch: { note }, expectedUnitId: null };
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
    resman = new Map([
      [WO_A, blank()],
      [WO_B, { ...blank(), notes: "Test tin" }],
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
    expect(resman.get(WO_A)?.notes).toBe("Second note");
  });

  test("a CLOSE and an EDIT racing on the same ticket do not revert each other", async () => {
    // The field case, exactly: the close and the edit flushes ride the same
    // sync tick. Both are read-modify-write over the whole ~48-control form,
    // so an edit that harvested BEFORE the close's POST carries Status="Not
    // Started" and puts it back — the app shows the ticket closed, ResMan does
    // not. Only assertion here is the resulting ResMan state; the schedule is
    // pinned by the test above.
    const closing = gate();
    const editing = gate();
    const close = writeWorkOrderDirect(
      closeWrite(WO_A, "Closed it out"),
      transport("C", { holdPost: closing.held, onPost: closing.hit }),
    );
    await closing.reached; // parked at its POST, nothing applied yet
    const edit = writeWorkOrderDirect(
      noteEdit(WO_A, "Typed on the way out"),
      transport("E", { holdPost: editing.held, onPost: editing.hit }),
    );
    await tick();
    await tick();

    // Let the close land and verify FIRST, so the only thing left to decide the
    // final state is which form the edit POSTs — harvested before the close
    // (the revert) or after it (correct).
    closing.open();
    const closed = await close;
    await editing.reached;
    editing.open();
    const edited = await edit;
    expect(closed.ok).toBe(true);
    expect(edited.ok).toBe(true);
    // The edit posted the form it harvested. Locked, that form already said
    // Completed; unlocked, it says "Not Started" and this is the revert.
    expect(resman.get(WO_A)?.status).toBe("Completed");
    expect(resman.get(WO_A)?.notes).toBe("Typed on the way out");
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
    expect(resman.get(WO_B)?.notes).toBe("Other ticket");
  });

  test("an unreachable employee roster is a RETRY, not a refusal", async () => {
    // The resolver reports a miss as `{ error }`, which the engine turns into
    // a WorkOrderWriteRefused — ResMan's verdict, terminal, and now enough to
    // BLOCK the pending edit. A roster that merely did not answer says nothing
    // about the edit, so it must not arrive dressed as a verdict.
    const deadRoster = (async (url: string, init?: RequestInit) => {
      if (url.includes("/Employees/EmployeeList")) {
        return { url, status: 503, text: async () => "" } as unknown as Response;
      }
      return transport("R")(url, init);
    }) as unknown as typeof fetch;

    const failure = await writeWorkOrderDirect(
      {
        workOrderId: WO_A,
        kind: "edit",
        patch: { technicianName: "Ben Bloch" },
        expectedUnitId: null,
      },
      deadRoster,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(WorkOrderWriteRefused);
    expect((failure as Error).message).toContain("will retry");
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

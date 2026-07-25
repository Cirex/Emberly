import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Stamping journey dates from the work-order detail screen.
 *
 * The completion date is the interesting one: setting it IS the close, so it
 * rides the pending-closes path rather than the field-edit path, and it has to
 * survive the same offline/retry story every other close does. The scheduled
 * date is an ordinary field edit, but its overlay has to retire correctly even
 * when ResMan echoes the instant back in a different string format.
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
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

/** Every close the store sent, with the completion date it carried. */
let closes: { id: string; note: string; completedAt: string | undefined }[] = [];
let gates: (() => void)[] = [];
let hold = false;

mock.module("@/lib/api/work-orders", () => ({
  closeWorkOrder: (id: string, note: string, _config: unknown, completedAt?: string) => {
    closes.push({ id, note, completedAt });
    if (!hold) return Promise.resolve();
    return new Promise<void>((resolve) => gates.push(resolve));
  },
  editWorkOrder: () => Promise.resolve(),
}));

const config = { baseUrl: "https://example.test", token: "t" } as never;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  store.clear();
  closes = [];
  gates = [];
  hold = false;
});

// ── the completion date closes the work order ──────────────────────────────

describe("stamping a completion date", () => {
  test("sends the chosen instant, not the moment the tech tapped", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    usePendingCloses.setState({ pending: {} });

    // Friday's job, closed out Monday morning.
    const friday = Date.UTC(2026, 6, 17, 15, 30);
    await usePendingCloses.getState().queueClose("wo-1", "", config, friday);

    expect(closes).toHaveLength(1);
    expect(closes[0].completedAt).toBe(new Date(friday).toISOString());
    expect(usePendingCloses.getState().pending["wo-1"].completedAt).toBe(friday);
    expect(usePendingCloses.getState().pending["wo-1"].acked).toBe(true);
  });

  test("closing on the spot still omits the date and lets the server decide", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    usePendingCloses.setState({ pending: {} });

    await usePendingCloses.getState().queueClose("wo-2", "valve replaced", config);

    expect(closes[0].completedAt).toBeUndefined();
    expect(usePendingCloses.getState().pending["wo-2"].completedAt).toBeUndefined();
  });

  test("a retry re-sends the same completion date, not a fresh now()", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    const stamped = Date.UTC(2026, 6, 17, 15, 30);
    usePendingCloses.setState({
      pending: {
        "wo-3": {
          workOrderId: "wo-3",
          note: "",
          completedAt: stamped,
          queuedAt: 1,
          acked: false,
          attempts: 1,
        },
      },
    });

    await usePendingCloses.getState().flush(config);

    expect(closes).toHaveLength(1);
    expect(closes[0].completedAt).toBe(new Date(stamped).toISOString());
    expect(usePendingCloses.getState().pending["wo-3"].acked).toBe(true);
  });

  test("correcting the date mid-flight is not acked by the older request", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    const wrong = Date.UTC(2026, 6, 17, 15, 30);
    const right = Date.UTC(2026, 6, 16, 9, 0);
    usePendingCloses.setState({
      pending: {
        "wo-4": {
          workOrderId: "wo-4",
          note: "",
          completedAt: wrong,
          queuedAt: 1,
          acked: false,
          attempts: 1,
        },
      },
    });

    hold = true;
    const inFlight = usePendingCloses.getState().flush(config);
    await tick();

    // The tech spots the mistake and re-stamps while the write is still out.
    hold = false;
    await usePendingCloses.getState().queueClose("wo-4", "", config, right);

    for (const resolve of gates) resolve();
    gates = [];
    await inFlight;

    // The corrected date must still be queued for a real send — acking it off
    // the back of the request that carried the WRONG date would lose it, since
    // flush only ever retries un-acked entries.
    const entry = usePendingCloses.getState().pending["wo-4"];
    expect(entry.completedAt).toBe(right);
    expect(closes.map((c) => c.completedAt)).toContain(new Date(right).toISOString());
  });

  test("cancelling a queued close drops the local completion stamp", async () => {
    const { usePendingCloses } = await import("@/lib/stores/pending-closes");
    usePendingCloses.setState({ pending: {} });

    await usePendingCloses.getState().queueClose("wo-5", "", config, Date.UTC(2026, 6, 17));
    expect(usePendingCloses.getState().pending["wo-5"]).toBeDefined();

    usePendingCloses.getState().remove("wo-5");
    expect(usePendingCloses.getState().pending["wo-5"]).toBeUndefined();
  });
});

// ── the scheduled date is an ordinary field edit ───────────────────────────

describe("stamping a scheduled date", () => {
  const row = (dateScheduled: string | null) =>
    ({
      resman_work_order_id: "wo-9",
      technician: "Sam",
      notes: "desc",
      completion_notes: "notes",
      date_scheduled: dateScheduled,
    }) as never;

  const seed = async (patch: Record<string, unknown>) => {
    const { usePendingEdits } = await import("@/lib/stores/pending-edits");
    usePendingEdits.setState({
      pending: {
        "wo-9": { workOrderId: "wo-9", patch: patch as never, editedAt: 1000, acked: true },
      },
    });
    return usePendingEdits;
  };

  test("the overlay retires once the mirror carries the same instant", async () => {
    const usePendingEdits = await seed({ scheduledAt: "2026-07-30T14:00:00.000Z" });
    // ResMan hands the date back in its own format — same moment, other spelling.
    usePendingEdits.getState().prune([row("2026-07-30T14:00:00+00:00")], 2000);
    expect(usePendingEdits.getState().pending["wo-9"]).toBeUndefined();
  });

  test("the overlay survives while the mirror still shows the old date", async () => {
    const usePendingEdits = await seed({ scheduledAt: "2026-07-30T14:00:00.000Z" });
    usePendingEdits.getState().prune([row("2026-07-24T09:00:00.000Z")], 2000);
    expect(usePendingEdits.getState().pending["wo-9"]).toBeDefined();
  });

  test("clearing the date retires only once the mirror is empty too", async () => {
    const stillSet = await seed({ scheduledAt: null });
    stillSet.getState().prune([row("2026-07-30T14:00:00.000Z")], 2000);
    expect(stillSet.getState().pending["wo-9"]).toBeDefined();

    const cleared = await seed({ scheduledAt: null });
    cleared.getState().prune([row(null)], 2000);
    expect(cleared.getState().pending["wo-9"]).toBeUndefined();
  });

  test("an unparseable date on either side falls back to an exact match", async () => {
    const mismatch = await seed({ scheduledAt: "2026-07-30T14:00:00.000Z" });
    mismatch.getState().prune([row("not a date")], 2000);
    expect(mismatch.getState().pending["wo-9"]).toBeDefined();
  });
});

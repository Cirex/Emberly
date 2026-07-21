import { describe, expect, test } from "bun:test";
import {
  listPmTemplateRounds,
  updatePmTaskStatus,
  type FetchLike,
  type PmTemplateRound,
} from "@/lib/api/pm-tasks";
import {
  buildPreventiveScoreCards,
  pmDaysLate,
  pmRoundOverdue,
  pmRoundTotals,
} from "@/lib/derived/pm-cards";

const CONFIG = { baseUrl: "https://example.test", token: "eapi_staff" };

/** Records requests and answers with the given response. */
function fetchStub(respond: () => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, impl };
}

function template(overrides: Partial<PmTemplateRound> = {}): PmTemplateRound {
  return {
    id: "tpl-1",
    name: "HVAC filter change",
    category: "HVAC",
    cadence: "quarterly",
    roundKey: "2026-07",
    dueDate: "2026-07-15",
    tasks: [],
    ...overrides,
  };
}

function task(overrides: Partial<PmTemplateRound["tasks"][number]> = {}) {
  return {
    id: "task-1",
    unitNumber: "1809 BA-1",
    status: "pending" as const,
    completedBy: "",
    completedAt: null,
    ...overrides,
  };
}

// ── API client ──────────────────────────────────────────────────────────────

describe("listPmTemplateRounds", () => {
  test("GETs the round with bearer auth and parses the template groups", async () => {
    const payload = {
      data: { templates: [template({ tasks: [task(), task({ id: "task-2", status: "done", completedBy: "QH", completedAt: "2026-07-06T12:00:00.000Z" })] })] },
    };
    const { calls, impl } = fetchStub(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    );
    const templates = await listPmTemplateRounds(CONFIG, impl);
    expect(calls[0].url).toBe("https://example.test/api/resman/pm-tasks");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer eapi_staff");
    expect(templates).toHaveLength(1);
    expect(templates[0].tasks.map((t) => t.status)).toEqual(["pending", "done"]);
  });

  test("401/403 throw the not-authorized error", async () => {
    for (const status of [401, 403]) {
      const { impl } = fetchStub(() => Promise.resolve(new Response("no", { status })));
      await expect(listPmTemplateRounds(CONFIG, impl)).rejects.toThrow(
        "Not authorized for the ResMan API",
      );
    }
  });
});

describe("updatePmTaskStatus", () => {
  test("POSTs the status with the tech's name and returns the server stamp", async () => {
    const { calls, impl } = fetchStub(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { id: "task-1", status: "done", completedBy: "Quinn H", completedAt: "2026-07-10T15:00:00.000Z" },
          }),
          { status: 200 },
        ),
      ),
    );
    const outcome = await updatePmTaskStatus("task-1", "done", "Quinn H", CONFIG, impl);
    expect(outcome).toEqual({
      ok: true,
      task: { id: "task-1", status: "done", completedBy: "Quinn H", completedAt: "2026-07-10T15:00:00.000Z" },
    });
    expect(calls[0].url).toBe("https://example.test/api/resman/pm-tasks/task-1");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ status: "done", completedBy: "Quinn H" });
  });

  test("pending omits the name so the server clears the stamp", async () => {
    const { calls, impl } = fetchStub(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: { id: "task-1", status: "pending", completedBy: "", completedAt: null } }),
          { status: 200 },
        ),
      ),
    );
    await updatePmTaskStatus("task-1", "pending", undefined, CONFIG, impl);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ status: "pending" });
  });

  test("throttling and server trouble are retryable; a 404 is not", async () => {
    for (const [status, retry] of [
      [429, true],
      [503, true],
      [408, true],
      [404, false],
      [400, false],
    ] as const) {
      const { impl } = fetchStub(() => Promise.resolve(new Response("x", { status })));
      expect(await updatePmTaskStatus("task-1", "done", "Q", CONFIG, impl)).toEqual({
        ok: false,
        retry,
        status,
      });
    }
  });
});

// ── Preventive score-card aggregation ───────────────────────────────────────

// A local-noon timestamp inside July 2026, safe across timezones.
const JULY_10 = new Date(2026, 6, 10, 12).getTime();

describe("pm round aggregation", () => {
  test("pmDaysLate counts whole days past a local due date", () => {
    expect(pmDaysLate("2026-07-15", JULY_10)).toBe(0); // not due yet
    expect(pmDaysLate("2026-07-10", JULY_10)).toBe(0); // due today
    expect(pmDaysLate("2026-07-01", JULY_10)).toBe(9);
    expect(pmDaysLate(null, JULY_10)).toBe(0);
  });

  test("pmRoundOverdue needs a late due date AND pending units", () => {
    const late = template({ dueDate: "2026-07-01", tasks: [task()] });
    const lateButFinished = template({ dueDate: "2026-07-01", tasks: [task({ status: "done" })] });
    const onTime = template({ tasks: [task()] });
    expect(pmRoundOverdue(late, JULY_10)).toBe(true);
    expect(pmRoundOverdue(lateButFinished, JULY_10)).toBe(false);
    expect(pmRoundOverdue(onTime, JULY_10)).toBe(false);
  });

  test("totals and the four score cards roll up due/done/overdue", () => {
    const templates = [
      template({
        id: "tpl-1",
        dueDate: "2026-07-01", // 9 days late
        tasks: [task(), task({ id: "t2", status: "done" }), task({ id: "t3", status: "skipped" })],
      }),
      template({ id: "tpl-2", dueDate: "2026-07-20", tasks: [task({ id: "t4" })] }),
      template({ id: "tpl-3", tasks: [] }), // upcoming — no tasks generated
    ];

    expect(pmRoundTotals(templates, JULY_10)).toEqual({
      total: 4,
      pending: 2,
      done: 1,
      skipped: 1,
      overdue: 1,
      rounds: 2,
      oldestLateDays: 9,
    });

    const cards = buildPreventiveScoreCards(templates, JULY_10);
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.key)).toEqual(["pm-total", "pm-due-round", "pm-done", "pm-overdue"]);
    expect(cards[1].value).toBe("2"); // due this round
    expect(cards[2].value).toBe("1"); // done
    expect(cards[2].caption).toContain("25%");
    expect(cards[3].value).toBe("1"); // overdue
    expect(cards[3].caption).toContain("9");
  });
});

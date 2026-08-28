import { describe, expect, test } from "bun:test";

import { buildOutbox, editFields, pendingCount, type OutboxInput } from "@/lib/derived/outbox";
import type { PendingClose } from "@/lib/stores/pending-closes";
import type { PendingEdit } from "@/lib/stores/pending-edits";
import type { WorkOrderPhotoQueue } from "@/lib/work-order-photo-queue";

const input = (over: Partial<OutboxInput> = {}): OutboxInput => ({
  closes: [],
  edits: [],
  photos: {},
  photosSyncing: false,
  ...over,
});

const close = (over: Partial<PendingClose> = {}): PendingClose => ({
  workOrderId: "wo-1",
  note: "done",
  queuedAt: 1000,
  acked: false,
  attempts: 1,
  ...over,
});

const edit = (over: Partial<PendingEdit> = {}): PendingEdit => ({
  workOrderId: "wo-2",
  patch: { completionNotes: "notes" },
  editedAt: 1000,
  acked: false,
  ...over,
});

const photoQueue = (
  ...ids: { id: string; workOrderId: string; attempts: number; queuedAt: number }[]
): WorkOrderPhotoQueue =>
  Object.fromEntries(
    ids.map((p) => [
      p.id,
      {
        photoId: p.id,
        workOrderId: p.workOrderId,
        phase: "completion" as const,
        queuedAt: p.queuedAt,
        attempts: p.attempts,
      },
    ]),
  );

describe("editFields", () => {
  test("returns the touched fields as stable keys, notes first", () => {
    expect(editFields({ completionNotes: "x" })).toEqual(["notes"]);
    expect(editFields({ technician: "Sam" })).toEqual(["assignment"]);
    expect(editFields({ description: "d", completionNotes: "n" })).toEqual([
      "notes",
      "description",
    ]);
  });
});

describe("buildOutbox state", () => {
  test("an un-acked close on its first attempt is queued", () => {
    const [item] = buildOutbox(input({ closes: [close({ attempts: 1 })] }));
    expect(item.state).toBe("queued");
  });

  test("an un-acked close that has retried is retrying", () => {
    const [item] = buildOutbox(input({ closes: [close({ attempts: 3 })] }));
    expect(item.state).toBe("retrying");
  });

  test("an acked close leaves the outbox — delivered means gone", () => {
    // acked = verified in ResMan; the entry lives on only so the optimistic
    // overlay keeps rendering until the mirror absorbs it. The outbox is
    // writes still on their way, and a verified write is not.
    const items = buildOutbox(input({ closes: [close({ acked: true })] }));
    expect(items).toHaveLength(0);
  });

  test("photos are sending while a flush is in flight", () => {
    const items = buildOutbox(
      input({
        photos: photoQueue({ id: "p1", workOrderId: "wo-9", attempts: 0, queuedAt: 5 }),
        photosSyncing: true,
      }),
    );
    expect(items[0].state).toBe("sending");
  });
});

describe("buildOutbox photo collapsing", () => {
  test("many photos of one work order collapse into a single counted row", () => {
    const items = buildOutbox(
      input({
        photos: photoQueue(
          { id: "p1", workOrderId: "wo-9", attempts: 0, queuedAt: 20 },
          { id: "p2", workOrderId: "wo-9", attempts: 2, queuedAt: 10 },
        ),
      }),
    );
    const photo = items.find((i) => i.kind === "photo");
    expect(photo?.photoCount).toBe(2);
    // The row's queuedAt is the oldest of the group; its state reflects the
    // least-settled member (one has retried), so it isn't shown as fresh.
    expect(photo?.queuedAt).toBe(10);
    expect(photo?.state).toBe("retrying");
  });

  test("a lone photo reads singular", () => {
    const items = buildOutbox(
      input({ photos: photoQueue({ id: "p1", workOrderId: "wo-9", attempts: 0, queuedAt: 5 }) }),
    );
    expect(items[0].photoCount).toBe(1);
  });
});

describe("buildOutbox ordering", () => {
  test("retrying first, then queued; delivered rows are absent entirely", () => {
    const items = buildOutbox(
      input({
        closes: [
          close({ workOrderId: "sent", acked: true, queuedAt: 1 }),
          close({ workOrderId: "queued", attempts: 1, queuedAt: 2 }),
          close({ workOrderId: "retry", attempts: 5, queuedAt: 3 }),
        ],
      }),
    );
    expect(items.map((i) => i.workOrderId)).toEqual(["retry", "queued"]);
  });
});

describe("pendingCount", () => {
  test("counts everything not yet accepted", () => {
    const items = buildOutbox(
      input({ closes: [close({ acked: true }), close({ workOrderId: "x", acked: false })] }),
    );
    expect(pendingCount(items)).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  MAX_UPLOAD_ATTEMPTS,
  PHOTO_STALE_MS,
  enqueuePhoto,
  pruneQueue,
  settlePhoto,
  settlementForOutcome,
  uploadOrder,
  type WorkOrderPhotoQueue,
} from "@/lib/work-order-photo-queue";

/** Fixture builder — a queue of entries with controllable age and attempts. */
function queueOf(
  ...entries: { photoId: string; queuedAt?: number; attempts?: number }[]
): WorkOrderPhotoQueue {
  const out: WorkOrderPhotoQueue = {};
  for (const e of entries) {
    out[e.photoId] = {
      photoId: e.photoId,
      workOrderId: "wo-1",
      phase: "completion",
      queuedAt: e.queuedAt ?? 1_000,
      attempts: e.attempts ?? 0,
    };
  }
  return out;
}

describe("enqueuePhoto", () => {
  test("adds the entry with a zeroed retry budget", () => {
    const q = enqueuePhoto({}, { photoId: "p1", workOrderId: "wo-9", phase: "after", queuedAt: 42 });
    expect(q.p1).toEqual({
      photoId: "p1",
      workOrderId: "wo-9",
      phase: "after",
      queuedAt: 42,
      attempts: 0,
    });
  });

  test("does not mutate the previous queue", () => {
    const before = queueOf({ photoId: "p1" });
    const after = enqueuePhoto(before, {
      photoId: "p2",
      workOrderId: "wo-1",
      phase: "completion",
      queuedAt: 2_000,
    });
    expect(Object.keys(before)).toEqual(["p1"]);
    expect(Object.keys(after).sort()).toEqual(["p1", "p2"]);
  });
});

describe("uploadOrder", () => {
  test("yields entries oldest first", () => {
    const q = queueOf(
      { photoId: "newer", queuedAt: 3_000 },
      { photoId: "oldest", queuedAt: 1_000 },
      { photoId: "middle", queuedAt: 2_000 },
    );
    expect(uploadOrder(q).map((e) => e.photoId)).toEqual(["oldest", "middle", "newer"]);
  });

  test("breaks queuedAt ties by photo id for a stable order", () => {
    const q = queueOf({ photoId: "b", queuedAt: 5 }, { photoId: "a", queuedAt: 5 });
    expect(uploadOrder(q).map((e) => e.photoId)).toEqual(["a", "b"]);
  });
});

describe("settlementForOutcome", () => {
  test("maps ok → uploaded, retry → retryable, otherwise fatal", () => {
    expect(settlementForOutcome({ ok: true, serverId: "s1" })).toBe("uploaded");
    expect(settlementForOutcome({ ok: false, retry: true, status: 404 })).toBe("retryable");
    expect(settlementForOutcome({ ok: false, retry: false, status: 400 })).toBe("fatal");
  });
});

describe("settlePhoto", () => {
  test("uploaded drops the entry and releases the local file", () => {
    const { queue, deleteFile } = settlePhoto(queueOf({ photoId: "p1" }), "p1", "uploaded");
    expect(queue.p1).toBeUndefined();
    expect(deleteFile).toBe(true);
  });

  test("missing drops the entry without a file delete (nothing to delete)", () => {
    const { queue, deleteFile } = settlePhoto(queueOf({ photoId: "p1" }), "p1", "missing");
    expect(queue.p1).toBeUndefined();
    expect(deleteFile).toBe(false);
  });

  test("fatal drops the entry and the file — retrying a rejection is pointless", () => {
    const { queue, deleteFile } = settlePhoto(queueOf({ photoId: "p1" }), "p1", "fatal");
    expect(queue.p1).toBeUndefined();
    expect(deleteFile).toBe(true);
  });

  test("retryable keeps the entry and spends one attempt", () => {
    const { queue, deleteFile } = settlePhoto(
      queueOf({ photoId: "p1", attempts: 3 }),
      "p1",
      "retryable",
    );
    expect(queue.p1?.attempts).toBe(4);
    expect(deleteFile).toBe(false);
  });

  test("retryable at the budget cap drops the entry and its file", () => {
    const { queue, deleteFile } = settlePhoto(
      queueOf({ photoId: "p1", attempts: MAX_UPLOAD_ATTEMPTS - 1 }),
      "p1",
      "retryable",
    );
    expect(queue.p1).toBeUndefined();
    expect(deleteFile).toBe(true);
  });

  test("offline leaves the queue untouched — no budget spent", () => {
    const before = queueOf({ photoId: "p1", attempts: 2 });
    const { queue, deleteFile } = settlePhoto(before, "p1", "offline");
    expect(queue).toBe(before);
    expect(deleteFile).toBe(false);
  });

  test("an unknown photo id is a no-op", () => {
    const before = queueOf({ photoId: "p1" });
    const { queue, deleteFile } = settlePhoto(before, "ghost", "uploaded");
    expect(queue).toBe(before);
    expect(deleteFile).toBe(false);
  });
});

describe("pruneQueue", () => {
  test("drops entries past the stale window and reports their ids", () => {
    const now = PHOTO_STALE_MS + 10_000;
    const q = queueOf(
      { photoId: "stale", queuedAt: 1 },
      { photoId: "fresh", queuedAt: now - 1_000 },
    );
    const { queue, droppedIds } = pruneQueue(q, now);
    expect(droppedIds).toEqual(["stale"]);
    expect(Object.keys(queue)).toEqual(["fresh"]);
  });

  test("returns the same queue object when nothing is stale", () => {
    const q = queueOf({ photoId: "p1", queuedAt: 500 });
    const { queue, droppedIds } = pruneQueue(q, 1_000);
    expect(queue).toBe(q);
    expect(droppedIds).toEqual([]);
  });
});

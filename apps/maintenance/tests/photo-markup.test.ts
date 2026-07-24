import { describe, expect, test } from "bun:test";

import {
  canExpireOriginal,
  displayUri,
  expirableOriginals,
  expireOriginal,
  hasMarkup,
  type MarkedPhoto,
} from "@/lib/derived/photo-markup";

const NOW = new Date("2026-07-24T12:00:00").getTime();

const photo = (over: Partial<MarkedPhoto> = {}): MarkedPhoto => ({
  photoId: "p1",
  workOrderId: "wo-1",
  phase: "before",
  originalUri: "file:///orig.jpg",
  markedUri: "file:///marked.jpg",
  strokes: [],
  capturedAt: NOW,
  originalExpiredAt: null,
  ...over,
});

const submitted = (...ids: string[]) => new Set(ids);

describe("canExpireOriginal", () => {
  test("retires the original once the work order is submitted and a marked copy exists", () => {
    expect(canExpireOriginal(photo(), submitted("wo-1"))).toBe(true);
  });

  test("refuses while the work order is unsubmitted", () => {
    expect(canExpireOriginal(photo(), submitted())).toBe(false);
    expect(canExpireOriginal(photo(), submitted("wo-2"))).toBe(false);
  });

  test("refuses when there is no marked copy to stand in its place", () => {
    // The whole point: an unmarked photo keeps its original forever, because
    // expiring it would leave no image at all.
    expect(canExpireOriginal(photo({ markedUri: null }), submitted("wo-1"))).toBe(false);
  });

  test("is idempotent — an already-expired original is not re-expired", () => {
    const gone = photo({ originalUri: null, originalExpiredAt: NOW - 1000 });
    expect(canExpireOriginal(gone, submitted("wo-1"))).toBe(false);
  });
});

describe("expirableOriginals", () => {
  test("selects only the photos that pass every guard", () => {
    const photos = [
      photo({ photoId: "keep-unsubmitted", workOrderId: "wo-2" }),
      photo({ photoId: "keep-unmarked", markedUri: null }),
      photo({ photoId: "keep-already-gone", originalUri: null }),
      photo({ photoId: "expire-me" }),
    ];
    const out = expirableOriginals(photos, submitted("wo-1"));
    expect(out.map((p) => p.photoId)).toEqual(["expire-me"]);
  });

  test("an empty set retires nothing", () => {
    expect(expirableOriginals([photo()], submitted())).toEqual([]);
  });

  test("never returns a photo whose original is its only copy", () => {
    // Belt and braces on the rule that actually destroys data.
    const risky = [
      photo({ photoId: "a", markedUri: null }),
      photo({ photoId: "b", markedUri: null, strokes: [] }),
    ];
    expect(expirableOriginals(risky, submitted("wo-1"))).toEqual([]);
  });
});

describe("expireOriginal", () => {
  test("clears the original and stamps when it went", () => {
    const out = expireOriginal(photo(), NOW);
    expect(out.originalUri).toBeNull();
    expect(out.originalExpiredAt).toBe(NOW);
    expect(out.markedUri).toBe("file:///marked.jpg");
  });

  test("leaves an already-expired record untouched", () => {
    const gone = photo({ originalUri: null, originalExpiredAt: 123 });
    expect(expireOriginal(gone, NOW)).toBe(gone);
  });
});

describe("displayUri", () => {
  test("prefers the marked copy", () => {
    expect(displayUri(photo())).toBe("file:///marked.jpg");
  });

  test("falls back to the original before any markup exists", () => {
    expect(displayUri(photo({ markedUri: null }))).toBe("file:///orig.jpg");
  });

  test("is null only when both are gone", () => {
    expect(displayUri(photo({ markedUri: null, originalUri: null }))).toBeNull();
  });
});

describe("hasMarkup", () => {
  test("tracks whether anything was drawn", () => {
    expect(hasMarkup(photo())).toBe(false);
    expect(
      hasMarkup(
        photo({
          strokes: [{ id: "s1", tool: "circle", color: "#FFD23F", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
        }),
      ),
    ).toBe(true);
  });
});

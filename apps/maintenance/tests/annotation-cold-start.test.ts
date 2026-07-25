import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Cold-start data loss regression.
 *
 * `useAnnotations` and `useAnnotationPhotos` are hand-hydrated stores, and
 * their only `hydrate()` caller is the Property Map screen — the FOURTH tab.
 * React Navigation's bottom tabs default to `lazy: true` and the layout sets
 * no override, so that screen is not mounted at launch. The tab layout's sync
 * tick fires immediately.
 *
 * Both `sync()` implementations end with an unconditional `persist()`. Run
 * unhydrated, that writes the empty initial state over real storage: every
 * queued local pin, un-pushed edit, photo↔pin mapping, pending upload and
 * pending server deletion is destroyed, silently, before the tech ever opens
 * the map.
 *
 * These tests drive `sync()` on a fresh store — exactly the launch path — and
 * assert the persisted payload still holds the queued work.
 */

// ── module mocks (must be registered before the stores are imported) ────────

const store = new Map<string, string>();

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

// The pull returns nothing, which is the dangerous case: with no remote rows a
// broken merge persists an empty list.
mock.module("@/lib/api/annotations", () => ({
  listAnnotations: async () => [],
  createAnnotation: async () => {
    throw new Error("offline");
  },
  updateAnnotation: async () => {
    throw new Error("offline");
  },
  deleteAnnotation: async () => {
    throw new Error("offline");
  },
  uploadAnnotationPhoto: async () => {
    throw new Error("offline");
  },
  deleteAnnotationPhoto: async () => {
    throw new Error("offline");
  },
}));

// Analytics reaches react-native (and its flow-typed entry, which bun can't
// parse) — the store only fires telemetry, so a stub keeps the test hermetic.
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
  resetAnalytics: () => {},
}));

mock.module("expo-file-system", () => ({
  Paths: { document: "/tmp" },
  Directory: class {
    exists = true;
    create() {}
  },
  File: class {
    exists = true;
    uri = "file:///tmp/x.jpg";
    async base64() {
      return "";
    }
    delete() {}
  },
}));

const ANNOTATION_KEY = "emberly_map_annotations_v2";
const PHOTO_KEY = "emberly_annotation_photos";
const config = { baseUrl: "https://example.test", token: "t" };

describe("annotations store — cold start", () => {
  beforeEach(() => store.clear());

  test("sync() on an unhydrated store does not erase a queued local pin", async () => {
    // A pin the tech dropped offline, sitting in storage from a previous run.
    const queued = [
      {
        id: "local-1",
        kind: "pin",
        title: "gas shutoff — 3rd valve",
        queued: true,
        dirty: true,
      },
    ];
    store.set(ANNOTATION_KEY, JSON.stringify(queued));

    const { useAnnotations } = await import("@/lib/stores/annotations");
    expect(useAnnotations.getState().hydrated).toBe(false); // launch state

    await useAnnotations.getState().sync(config as never);

    const persisted = JSON.parse(store.get(ANNOTATION_KEY) ?? "[]");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe("local-1");
    expect(persisted[0].title).toBe("gas shutoff — 3rd valve");
  });
});

describe("annotation-photos store — cold start", () => {
  beforeEach(() => store.clear());

  test("sync() on an unhydrated store does not erase queued uploads or mappings", async () => {
    store.set(
      PHOTO_KEY,
      JSON.stringify({
        byAnnotation: { "ann-1": ["photo-1"] },
        pendingUploads: { "photo-1": "ann-1" },
        serverIds: {},
        pendingRemovals: ["server-9"],
      }),
    );

    const { useAnnotationPhotos } = await import("@/lib/stores/annotation-photos");
    expect(useAnnotationPhotos.getState().hydrated).toBe(false);

    await useAnnotationPhotos.getState().sync(config as never);

    const persisted = JSON.parse(store.get(PHOTO_KEY) ?? "{}");
    expect(persisted.byAnnotation["ann-1"]).toEqual(["photo-1"]);
    // The upload threw (offline), so the queue must still hold it.
    expect(persisted.pendingUploads["photo-1"]).toBe("ann-1");
    // The server deletion also threw, so it must still be queued.
    expect(persisted.pendingRemovals).toContain("server-9");
  });

  test("a corrupt store still hydrates, so sync can never wedge off permanently", async () => {
    store.set(PHOTO_KEY, "{not json");
    const { useAnnotationPhotos } = await import("@/lib/stores/annotation-photos");
    await useAnnotationPhotos.getState().hydrate();
    expect(useAnnotationPhotos.getState().hydrated).toBe(true);
  });
});

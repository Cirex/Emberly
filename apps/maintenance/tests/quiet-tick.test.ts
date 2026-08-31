import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a sync tick costs when the server has no news.
 *
 * The tick runs every 15 seconds, all day, on a technician's phone. Three
 * sources of pure waste lived here, each of which spent battery and
 * main-thread time to conclude that nothing had happened:
 *
 *   - the PM store compared the whole round with two full JSON.stringify
 *     passes — four serializations a minute on Hermes;
 *   - the annotations store wrote state AND AsyncStorage unconditionally after
 *     every pull, re-rendering the Property Map and rebuilding its Skia canvas
 *     on the screen a tech keeps open while walking;
 *   - the Property Map subscribed to four stores with no selector, so any
 *     field of any of them — bookkeeping flags included — re-rendered it.
 *
 * Both directions matter in every test below. Doing the work when nothing
 * changed is the waste; SKIPPING it when something did change leaves a
 * technician looking at stale work, which is far worse.
 */

// ── module mocks (must be registered before the stores are imported) ────────

const disk = new Map<string, string>();
let diskWrites = 0;
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => disk.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      diskWrites += 1;
      disk.set(k, v);
    },
    removeItem: async (k: string) => void disk.delete(k),
  },
}));

mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

const config = { baseUrl: "https://example.test", token: "t" } as never;

/** Let the persist middleware's in-flight write land before counting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── PM round ───────────────────────────────────────────────────────────────

interface Task {
  id: string;
  unitNumber: string;
  status: string;
  completedBy: string;
  completedAt: string | null;
}
interface Template {
  id: string;
  name: string;
  cadence: string;
  category: string;
  roundKey: string;
  dueDate: string | null;
  tasks: Task[];
}

/** The server's current round. Rebuilt per read, like a real fetch+parse. */
let round: Template[] = [];

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    unitNumber: "1809 BA-1",
    status: "pending",
    completedBy: "",
    completedAt: null,
    ...over,
  };
}

function template(over: Partial<Template> = {}): Template {
  return {
    id: "tpl-1",
    name: "HVAC filter change",
    cadence: "quarterly",
    category: "HVAC",
    roundKey: "2026-07",
    dueDate: "2026-07-15",
    tasks: [task()],
    ...over,
  };
}

/** A fresh deep copy — the store must never be handed its own objects back. */
function serve(): Template[] {
  return round.map((t) => ({ ...t, tasks: t.tasks.map((k) => ({ ...k })) }));
}

mock.module("@/lib/api/pm-tasks", () => ({
  listPmTemplateRounds: async () => serve(),
  updatePmTaskStatus: async () => ({ ok: false, retry: false, status: 404 }),
}));

/** Runs `fn` with JSON.stringify counted. */
async function countingStringify(fn: () => Promise<void>): Promise<number> {
  const real = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof real>) => {
    calls += 1;
    return real(...args);
  }) as typeof JSON.stringify;
  try {
    await fn();
  } finally {
    JSON.stringify = real;
  }
  return calls;
}

describe("preventive maintenance — a quiet tick", () => {
  beforeEach(() => {
    disk.clear();
    diskWrites = 0;
    round = [template()];
  });

  test("serializes nothing to decide the round is unchanged", async () => {
    const { usePm } = await import("@/lib/stores/pm");
    usePm.setState({ templates: serve() as never, dataVersion: 3, refreshedAt: 0 });
    await settle();
    diskWrites = 0;

    // The compare this replaced stringified BOTH sides — two full copies of
    // the round, four times a minute, forever.
    const calls = await countingStringify(() => usePm.getState().refresh(config));

    expect(calls).toBe(0);
    // …and the verdict is still "nothing moved": no derived rebuild.
    expect(usePm.getState().dataVersion).toBe(3);
    expect(usePm.getState().refreshedAt).toBeGreaterThan(0);
    expect(diskWrites).toBe(0);
  });

  test("a task checked off elsewhere is still caught", async () => {
    // The nested half. A compare that only looked at the template's own fields
    // would leave the tech's board showing a unit as pending forever.
    const { usePm } = await import("@/lib/stores/pm");
    usePm.setState({ templates: serve() as never, dataVersion: 3 });
    round = [template({ tasks: [task({ status: "done", completedBy: "QH" })] })];

    await usePm.getState().refresh(config);

    expect(usePm.getState().dataVersion).toBe(4);
    expect(usePm.getState().templates[0].tasks[0].status).toBe("done");
  });

  test("added, removed and rescheduled templates are all caught", async () => {
    const { usePm } = await import("@/lib/stores/pm");

    usePm.setState({ templates: serve() as never, dataVersion: 0 });
    round = [template({ dueDate: "2026-08-01" })];
    await usePm.getState().refresh(config);
    expect(usePm.getState().dataVersion).toBe(1);

    round = [template({ dueDate: "2026-08-01" }), template({ id: "tpl-2" })];
    await usePm.getState().refresh(config);
    expect(usePm.getState().dataVersion).toBe(2);

    round = [];
    await usePm.getState().refresh(config);
    expect(usePm.getState().dataVersion).toBe(3);
  });
});

// ── map annotations ────────────────────────────────────────────────────────

interface Remote {
  id: string;
  title: string;
  notes: string;
  normalizedX: number;
  normalizedY: number;
  colorHex: string;
  icon: string;
  kind: string;
  utilityType: string | null;
  points: { x: number; y: number }[] | null;
  lineStyle: string | null;
  lineWeight: string | null;
  flowArrows: boolean | null;
  createdByDisplayName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  version: number;
}

let layer: Remote[] = [];

function remote(over: Partial<Remote> = {}): Remote {
  return {
    id: "srv-1",
    title: "gas shutoff",
    notes: "",
    normalizedX: 0.5,
    normalizedY: 0.5,
    colorHex: "#A2A921",
    icon: "document-text",
    kind: "pin",
    utilityType: null,
    points: null,
    lineStyle: null,
    lineWeight: null,
    flowArrows: null,
    createdByDisplayName: null,
    createdAt: null,
    updatedAt: null,
    deletedAt: null,
    version: 1,
    ...over,
  };
}

mock.module("@/lib/api/annotations", () => ({
  // Fresh objects per pull, exactly like a parsed HTTP response.
  listAnnotations: async () =>
    layer.map((r) => ({ ...r, points: r.points?.map((p) => ({ ...p })) ?? null })),
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

describe("map annotations — a quiet tick", () => {
  beforeEach(() => {
    disk.clear();
    diskWrites = 0;
    layer = [remote()];
  });

  test("a pull that brings nothing writes neither state nor disk", async () => {
    const { useAnnotations } = await import("@/lib/stores/annotations");
    useAnnotations.setState({ annotations: [], hydrated: true });
    await useAnnotations.getState().sync(config);
    const settled = useAnnotations.getState().annotations;
    diskWrites = 0;

    await useAnnotations.getState().sync(config);
    await useAnnotations.getState().sync(config);

    // Same array object: no re-render of the Property Map, no Skia rebuild.
    expect(useAnnotations.getState().annotations).toBe(settled);
    expect(diskWrites).toBe(0);
  });

  test("an edit made in the admin portal still lands", async () => {
    const { useAnnotations } = await import("@/lib/stores/annotations");
    useAnnotations.setState({ annotations: [], hydrated: true });
    await useAnnotations.getState().sync(config);
    diskWrites = 0;

    layer = [remote({ title: "gas shutoff — 3rd valve", version: 2 })];
    await useAnnotations.getState().sync(config);

    expect(useAnnotations.getState().annotations[0].title).toBe("gas shutoff — 3rd valve");
    expect(diskWrites).toBe(1);
    expect(disk.get(ANNOTATION_KEY)).toContain("3rd valve");
  });

  test("a utility run whose vertices moved still lands", async () => {
    // The nested half. `points` is the only non-scalar on an annotation, so a
    // compare that skipped it would freeze a redrawn sewer line on the map.
    const { useAnnotations } = await import("@/lib/stores/annotations");
    const line = {
      kind: "utility_line",
      utilityType: "sewer",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 },
      ],
    };
    layer = [remote({ id: "srv-line", ...line })];
    useAnnotations.setState({ annotations: [], hydrated: true });
    await useAnnotations.getState().sync(config);
    diskWrites = 0;

    // Idle first: identical vertices must not count as a change.
    await useAnnotations.getState().sync(config);
    expect(diskWrites).toBe(0);

    layer = [
      remote({
        id: "srv-line",
        ...line,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.4 },
        ],
      }),
    ];
    await useAnnotations.getState().sync(config);

    expect(useAnnotations.getState().annotations[0].points?.[1]).toEqual({ x: 0.9, y: 0.4 });
    expect(diskWrites).toBe(1);
  });

  test("a pin deleted server-side still leaves the device", async () => {
    const { useAnnotations } = await import("@/lib/stores/annotations");
    useAnnotations.setState({ annotations: [], hydrated: true });
    await useAnnotations.getState().sync(config);
    diskWrites = 0;

    layer = [];
    await useAnnotations.getState().sync(config);

    expect(useAnnotations.getState().annotations).toHaveLength(0);
    expect(diskWrites).toBe(1);
  });
});

// ── Property Map subscriptions ─────────────────────────────────────────────

/**
 * The screen is a React Native + Skia tree that cannot be rendered here, so
 * the subscription shape is checked at the source. Both failure modes are
 * covered: a bare `useStore()` re-renders the map on every field of that store
 * (including per-tick bookkeeping like `syncing` and `refreshedAt`), and a
 * selector missing a field the screen reads leaves the map STALE.
 */
const SOURCE = readFileSync(
  join(import.meta.dir, "..", "app", "(tabs)", "property-map.tsx"),
  "utf8",
);

/** The `useShallow((s) => ({ … }))` block bound to `name`. */
function selectorFor(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = use`);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n  const ", start + 1);
  return SOURCE.slice(start, end === -1 ? undefined : end);
}

const SUBSCRIPTIONS: { local: string; hook: string; extra?: string[] }[] = [
  { local: "units", hook: "useUnits" },
  { local: "ann", hook: "useAnnotations" },
  // tagsFor() reads byUnit, so the subscription has to carry it or a new tag
  // never reaches the screen.
  { local: "tagStore", hook: "useTags", extra: ["byUnit"] },
  { local: "tour", hook: "useTour" },
  { local: "photos", hook: "useAnnotationPhotos" },
];

describe("Property Map — store subscriptions", () => {
  test("no store is subscribed whole", () => {
    for (const { hook } of SUBSCRIPTIONS) {
      expect({ hook, bare: SOURCE.includes(`${hook}()`) }).toEqual({ hook, bare: false });
    }
  });

  test("every field the screen reads is in its selector", () => {
    for (const { local, extra } of SUBSCRIPTIONS) {
      const selector = selectorFor(local);
      const read = new Set<string>();
      for (const m of SOURCE.matchAll(new RegExp(`\\b${local}\\.(\\w+)`, "g"))) read.add(m[1]);
      for (const field of extra ?? []) read.add(field);
      const missing = [...read].filter((f) => !new RegExp(`\\b${f}:`).test(selector));
      expect({ local, missing }).toEqual({ local, missing: [] });
    }
  });
});

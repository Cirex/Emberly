import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
  type UtilityPoint,
  type UtilityType,
} from "@/lib/api/annotations";
import { fromRemote, toFields, type MapAnnotation } from "@/lib/annotation-mapping";
import { UTILITY_COLORS } from "@/lib/utility-lines";
import type { StaffConfig } from "@/lib/stores/config";
import { useAnnotationPhotos } from "@/lib/stores/annotation-photos";
import { useUtilityVisibility } from "@/lib/stores/utility-visibility";

type ScannerConfig = StaffConfig;

/**
 * Annotations on the property map, shared with the admin portal's layered
 * annotation channel: plain pins plus the utility layer's pins and drawn
 * polylines (see lib/annotation-mapping.ts for the model + wire mapping).
 *
 * The store is offline-first: every mutation applies locally and is queued;
 * `sync()` pushes the queue and then pulls the server copy, which is the
 * truth. Edits made in the admin portal land here on the next sync tick, and
 * a tech's pins survive a dead network until one succeeds.
 */
export type { MapAnnotation };

/** Palette for annotation pins (brand + status hues). */
export const ANNOTATION_COLORS = ["#A2A921", "#D1382E", "#458ADB", "#7A6BC7", "#E38736"];

const KEY = "emberly_map_annotations_v2";
let seq = 0;
const isLocal = (id: string) => id.startsWith("local-");
const newLocalId = () => `local-${Date.now()}-${seq++}`;

interface AnnotationsState {
  /** Everything, including queued deletions — use visible() for rendering. */
  annotations: MapAnnotation[];
  /**
   * The pin open in the editor dialog. Lives here rather than in the screen
   * because sync() swaps a fresh pin's local id for the server's — if that
   * happens mid-edit, the dialog must follow the pin to its new id.
   */
  editingId?: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setEditing: (id?: string) => void;
  add: (x: number, y: number) => MapAnnotation;
  /** Drop a utility pin (kind 'utility_pin'), queued for sync like add(). */
  addUtilityPin: (x: number, y: number, utilityType: UtilityType) => MapAnnotation;
  /** Save a drawn utility run (kind 'utility_line', ≥2 vertices), queued for sync. */
  addUtilityLine: (
    points: UtilityPoint[],
    utilityType: UtilityType,
    presentation?: Pick<MapAnnotation, "lineStyle" | "lineWeight" | "flowArrows">,
  ) => MapAnnotation;
  update: (id: string, patch: Partial<Omit<MapAnnotation, "id">>) => void;
  remove: (id: string) => void;
  /** Push queued mutations, then pull the server state. Safe to call often. */
  sync: (config: ScannerConfig) => Promise<void>;
  visible: () => MapAnnotation[];
}

function persist(annotations: MapAnnotation[]): void {
  void AsyncStorage.setItem(KEY, JSON.stringify(annotations));
}

/** Vertices of a drawn run, compared coordinate by coordinate. */
function pointsEqual(a: UtilityPoint[] | undefined, b: UtilityPoint[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
  }
  return true;
}

/**
 * Keys are walked rather than listed so a field added to MapAnnotation is
 * compared automatically — a compare that silently ignores a new field leaves
 * the map showing a stale pin, which is far worse than an extra render.
 * `points` is the one non-scalar.
 */
function annotationEqual(a: MapAnnotation, b: MapAnnotation): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof MapAnnotation)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (key === "points") {
      if (!pointsEqual(a.points, b.points)) return false;
    } else if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Whether a merged pull differs from what the store already holds.
 *
 * Order-sensitive: the merge below rebuilds the list in server order with the
 * queued locals appended, so a run of quiet ticks produces the same order.
 */
function annotationsEqual(a: readonly MapAnnotation[], b: readonly MapAnnotation[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!annotationEqual(a[i], b[i])) return false;
  }
  return true;
}

let syncing = false;

export const useAnnotations = create<AnnotationsState>((set, get) => ({
  annotations: [],
  hydrated: false,

  hydrate: async () => {
    let parsed: MapAnnotation[] = [];
    try {
      const raw = await AsyncStorage.getItem(KEY);
      parsed = raw ? JSON.parse(raw) : [];
    } catch {
      // Unreadable store — treat as empty, but still mark hydrated. Leaving
      // `hydrated` false would block sync() forever (see the guard there).
    }
    // Rows persisted before the utility layer carry no kind — they are pins.
    set({ annotations: parsed.map((a) => (a.kind ? a : { ...a, kind: "pin" })), hydrated: true });
  },

  setEditing: (editingId) => set({ editingId }),

  add: (x, y) => {
    const item: MapAnnotation = {
      id: newLocalId(),
      x,
      y,
      title: "",
      notes: "",
      color: ANNOTATION_COLORS[0],
      icon: "document-text",
      kind: "pin",
      version: 0,
      dirty: true,
    };
    const annotations = [...get().annotations, item];
    set({ annotations });
    persist(annotations);
    return item;
  },

  addUtilityPin: (x, y, utilityType) => {
    const item: MapAnnotation = {
      id: newLocalId(),
      x,
      y,
      title: "",
      notes: "",
      color: UTILITY_COLORS[utilityType],
      icon: "construct",
      kind: "utility_pin",
      utilityType,
      version: 0,
      dirty: true,
    };
    const annotations = [...get().annotations, item];
    set({ annotations });
    persist(annotations);
    return item;
  },

  addUtilityLine: (points, utilityType, presentation) => {
    const item: MapAnnotation = {
      id: newLocalId(),
      // The server keeps normalized_x/y NOT NULL for every kind — a line
      // anchors them on its first vertex (contract addendum).
      x: points[0]?.x ?? 0,
      y: points[0]?.y ?? 0,
      title: "",
      notes: "",
      color: UTILITY_COLORS[utilityType],
      icon: "construct",
      kind: "utility_line",
      utilityType,
      points: [...points],
      ...presentation,
      version: 0,
      dirty: true,
    };
    const annotations = [...get().annotations, item];
    set({ annotations });
    persist(annotations);
    return item;
  },

  update: (id, patch) => {
    const annotations = get().annotations.map((a) =>
      a.id === id ? { ...a, ...patch, dirty: true } : a,
    );
    set({ annotations });
    persist(annotations);
  },

  remove: (id) => {
    // A pin the server never saw can simply vanish; anything else becomes a
    // queued deletion so the server copy goes too. Its photos go either way.
    useAnnotationPhotos.getState().removeAll(id);
    const annotations = isLocal(id)
      ? get().annotations.filter((a) => a.id !== id)
      : get().annotations.map((a) => (a.id === id ? { ...a, removed: true } : a));
    set({ annotations });
    persist(annotations);
  },

  sync: async (config) => {
    if (syncing) return;
    // Hydrate first, ALWAYS. This store is loaded by hand and its only
    // hydrate() caller is the Property Map screen — the fourth tab, which
    // React Navigation does not mount at launch (bottom tabs default to
    // lazy). The sync tick fires immediately on launch, so without this the
    // pull below would merge onto an EMPTY list and persist() would write
    // that over the real store: every queued local pin and un-pushed edit
    // silently destroyed before the tech ever opens the map.
    if (!get().hydrated) await get().hydrate();
    syncing = true;

    const apply = (mutate: (list: MapAnnotation[]) => MapAnnotation[]) => {
      const annotations = mutate(get().annotations);
      set({ annotations });
      persist(annotations);
    };

    try {
      // Push phase. Each success clears its queue flag immediately; a failed
      // request leaves the item queued for the next tick. Version conflicts
      // are resolved by surrender — the server copy wins in the pull below.
      for (const a of [...get().annotations]) {
        try {
          if (a.removed) {
            const res = await deleteAnnotation(a.id, a.version, config);
            if (res.ok) apply((l) => l.filter((x) => x.id !== a.id));
            else if (res.conflict)
              apply((l) => l.map((x) => (x.id === a.id ? { ...x, removed: undefined } : x)));
          } else if (a.dirty && isLocal(a.id)) {
            const created = await createAnnotation(toFields(a), config);
            // The pin's photos, any open editor, and a hidden-run flag are
            // keyed by its id — all follow the swap to the server id.
            useAnnotationPhotos.getState().reassign(a.id, created.id);
            useUtilityVisibility.getState().renameId(a.id, created.id);
            if (get().editingId === a.id) set({ editingId: created.id });
            apply((l) => l.map((x) => (x.id === a.id ? fromRemote(created) : x)));
          } else if (a.dirty) {
            const res = await updateAnnotation(a.id, toFields(a), a.version, config);
            if (res.ok) {
              // If the user kept typing while the request was in flight, keep
              // their newer text and only adopt the bumped version — the next
              // tick pushes the rest.
              apply((l) =>
                l.map((x) => {
                  if (x.id !== a.id) return x;
                  const unchanged = JSON.stringify(toFields(x)) === JSON.stringify(toFields(a));
                  return unchanged
                    ? fromRemote(res.annotation)
                    : { ...x, version: res.annotation.version };
                }),
              );
            } else if (res.conflict) {
              apply((l) => l.map((x) => (x.id === a.id ? { ...x, dirty: undefined } : x)));
            }
          }
        } catch {
          // Offline or server trouble — stays queued.
        }
      }

      const remote = await listAnnotations(config);
      // Anything still flagged is a failed push — keep the local copy so the
      // pull doesn't clobber a change the server hasn't seen yet.
      const stillQueued = get().annotations.filter((a) => a.dirty || a.removed);
      const queuedLocal = stillQueued.filter((a) => isLocal(a.id));
      const queuedById = new Map(stillQueued.filter((a) => !isLocal(a.id)).map((a) => [a.id, a]));
      const merged = remote.map((r) => queuedById.get(r.id) ?? fromRemote(r)).concat(queuedLocal);
      // Only write when the pull actually brought something. This runs every
      // 15s on the screen a tech keeps open while walking the property, and an
      // unconditional write re-serialized the whole annotation layer to
      // AsyncStorage, re-rendered the Property Map and rebuilt its Skia canvas
      // — all to land exactly the rows the device already had.
      if (!annotationsEqual(merged, get().annotations)) {
        set({ annotations: merged });
        persist(merged);
      }
      reportSyncSucceeded("annotations");
    } catch {
      // Pull failed (offline) — cached pins stand, queue intact.
      reportSyncFailed("annotations");
    } finally {
      syncing = false;
    }
  },

  visible: () => get().annotations.filter((a) => !a.removed),
}));

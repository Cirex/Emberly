import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
  type RemoteAnnotation,
} from "@/lib/api/annotations";
import type { StaffConfig } from "@/lib/stores/config";
import { useAnnotationPhotos } from "@/lib/stores/annotation-photos";

type ScannerConfig = StaffConfig;

/**
 * A pin on the property map (normalized 0–1 coordinates), shared with the
 * admin portal's security layer.
 *
 * The store is offline-first: every mutation applies locally and is queued;
 * `sync()` pushes the queue and then pulls the server copy, which is the
 * truth. Edits made in the admin portal land here on the next sync tick, and
 * a guard's pins survive a dead network until one succeeds.
 */
export interface MapAnnotation {
  id: string;
  x: number;
  y: number;
  title: string;
  notes: string;
  color: string;
  /** Ionicons glyph shown on the pin. */
  icon: string;
  /** Server row version; 0 until the pin has been accepted by the server. */
  version: number;
  /** Local changes not yet pushed. */
  dirty?: boolean;
  /** Deleted locally; awaiting the server round-trip. Hidden from the UI. */
  removed?: boolean;
}

/** Palette for annotation pins (brand + status hues). */
export const ANNOTATION_COLORS = ["#A2A921", "#D1382E", "#458ADB", "#7A6BC7", "#E38736"];

const KEY = "emberly_map_annotations_v2";
let seq = 0;
const isLocal = (id: string) => id.startsWith("local-");

function fromRemote(r: RemoteAnnotation): MapAnnotation {
  return {
    id: r.id,
    x: r.normalizedX,
    y: r.normalizedY,
    title: r.title,
    notes: r.notes,
    color: r.colorHex,
    icon: r.icon,
    version: r.version,
  };
}

function toFields(a: MapAnnotation) {
  return {
    title: a.title,
    notes: a.notes,
    normalizedX: a.x,
    normalizedY: a.y,
    colorHex: a.color,
    icon: a.icon || "document-text",
  };
}

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
  update: (id: string, patch: Partial<Omit<MapAnnotation, "id">>) => void;
  remove: (id: string) => void;
  /** Push queued mutations, then pull the server state. Safe to call often. */
  sync: (config: ScannerConfig) => Promise<void>;
  visible: () => MapAnnotation[];
}

function persist(annotations: MapAnnotation[]): void {
  void AsyncStorage.setItem(KEY, JSON.stringify(annotations));
}

let syncing = false;

export const useAnnotations = create<AnnotationsState>((set, get) => ({
  annotations: [],
  hydrated: false,

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY);
    set({ annotations: raw ? JSON.parse(raw) : [], hydrated: true });
  },

  setEditing: (editingId) => set({ editingId }),

  add: (x, y) => {
    const item: MapAnnotation = {
      id: `local-${Date.now()}-${seq++}`,
      x,
      y,
      title: "",
      notes: "",
      color: ANNOTATION_COLORS[0],
      icon: "document-text",
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
            else if (res.conflict) apply((l) => l.map((x) => (x.id === a.id ? { ...x, removed: undefined } : x)));
          } else if (a.dirty && isLocal(a.id)) {
            const created = await createAnnotation(toFields(a), config);
            // The pin's photos and any open editor are keyed by its id —
            // both follow the swap to the server id.
            useAnnotationPhotos.getState().reassign(a.id, created.id);
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
                  return unchanged ? fromRemote(res.annotation) : { ...x, version: res.annotation.version };
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
      set({ annotations: merged });
      persist(merged);
    } catch {
      // Pull failed (offline) — cached pins stand, queue intact.
    } finally {
      syncing = false;
    }
  },

  visible: () => get().annotations.filter((a) => !a.removed),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";
import { deleteAnnotationPhoto, uploadAnnotationPhoto } from "@/lib/api/annotations";
import type { ScannerConfig } from "@/lib/api/scanner";

/**
 * Photos attached to map annotations. JPEGs live device-local under
 * Documents/annotation-photos/ (the guard's instant reference, like the Swift
 * app's MapAnnotationPhotoStore) and upload to the server on the sync tick so
 * the admin portal sees them too. The local file stays after upload — it's the
 * cache; the server copy is the shared record.
 */

const KEY = "emberly_annotation_photos";
let seq = 0;

function dir(): Directory {
  const d = new Directory(Paths.document, "annotation-photos");
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

export function photoUri(photoId: string): string {
  return new File(dir(), `${photoId}.jpg`).uri;
}

interface PersistedState {
  /** annotation id → photo ids (files under annotation-photos/). */
  byAnnotation: Record<string, string[]>;
  /** photo ids captured here and not yet uploaded, keyed to their annotation. */
  pendingUploads: Record<string, string>;
  /** local photo id → server photo id, once uploaded. */
  serverIds: Record<string, string>;
  /** server photo ids whose local copy was deleted — server delete queued. */
  pendingRemovals: string[];
}

interface AnnotationPhotosState extends PersistedState {
  hydrated: boolean;
  syncing: boolean;
  hydrate: () => Promise<void>;
  /** Copy a picked image into the store and attach it. Returns the photo id. */
  add: (annotationId: string, sourceUri: string) => Promise<string>;
  remove: (annotationId: string, photoId: string) => void;
  /** Delete every photo attached to an annotation (pin deleted). */
  removeAll: (annotationId: string) => void;
  /** A synced pin trades its local id for the server's — the photos follow. */
  reassign: (fromId: string, toId: string) => void;
  /** Push pending uploads/removals; pins must sync first (404 → retry later). */
  sync: (config: ScannerConfig) => Promise<void>;
}

function persist(state: PersistedState): void {
  void AsyncStorage.setItem(
    KEY,
    JSON.stringify({
      byAnnotation: state.byAnnotation,
      pendingUploads: state.pendingUploads,
      serverIds: state.serverIds,
      pendingRemovals: state.pendingRemovals,
    }),
  );
}

function snapshot(get: () => AnnotationPhotosState): PersistedState {
  const s = get();
  return {
    byAnnotation: s.byAnnotation,
    pendingUploads: s.pendingUploads,
    serverIds: s.serverIds,
    pendingRemovals: s.pendingRemovals,
  };
}

export const useAnnotationPhotos = create<AnnotationPhotosState>((set, get) => ({
  byAnnotation: {},
  pendingUploads: {},
  serverIds: {},
  pendingRemovals: [],
  hydrated: false,
  syncing: false,

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // Pre-sync installs persisted a bare byAnnotation map at this key. Their
    // photos predate uploading entirely, so queue every one — this runs once,
    // and the queue is dropped per-photo as uploads land.
    const legacy = raw && !parsed.byAnnotation && !parsed.pendingUploads;
    const byAnnotation: Record<string, string[]> = legacy ? parsed : (parsed.byAnnotation ?? {});
    let pendingUploads: Record<string, string> = parsed.pendingUploads ?? {};
    if (legacy) {
      pendingUploads = {};
      for (const [annotationId, photoIds] of Object.entries(byAnnotation)) {
        for (const photoId of photoIds) pendingUploads[photoId] = annotationId;
      }
    }
    set({
      byAnnotation,
      pendingUploads,
      serverIds: parsed.serverIds ?? {},
      pendingRemovals: parsed.pendingRemovals ?? [],
      hydrated: true,
    });
    if (legacy) persist(snapshot(get));
  },

  add: async (annotationId, sourceUri) => {
    const photoId = `${Date.now()}-${seq++}`;
    const source = new File(sourceUri);
    source.copy(new File(dir(), `${photoId}.jpg`));
    set((s) => ({
      byAnnotation: {
        ...s.byAnnotation,
        [annotationId]: [...(s.byAnnotation[annotationId] ?? []), photoId],
      },
      pendingUploads: { ...s.pendingUploads, [photoId]: annotationId },
    }));
    persist(snapshot(get));
    return photoId;
  },

  remove: (annotationId, photoId) => {
    try {
      new File(dir(), `${photoId}.jpg`).delete();
    } catch {
      // The index entry still goes; a stray file is harmless.
    }
    set((s) => {
      const pendingUploads = { ...s.pendingUploads };
      delete pendingUploads[photoId];
      const serverIds = { ...s.serverIds };
      const serverId = serverIds[photoId];
      delete serverIds[photoId];
      return {
        byAnnotation: {
          ...s.byAnnotation,
          [annotationId]: (s.byAnnotation[annotationId] ?? []).filter((id) => id !== photoId),
        },
        pendingUploads,
        serverIds,
        pendingRemovals: serverId ? [...s.pendingRemovals, serverId] : s.pendingRemovals,
      };
    });
    persist(snapshot(get));
  },

  removeAll: (annotationId) => {
    const photoIds = get().byAnnotation[annotationId] ?? [];
    for (const photoId of photoIds) {
      try {
        new File(dir(), `${photoId}.jpg`).delete();
      } catch {
        /* see above */
      }
    }
    set((s) => {
      const byAnnotation = { ...s.byAnnotation };
      delete byAnnotation[annotationId];
      const pendingUploads = { ...s.pendingUploads };
      const serverIds = { ...s.serverIds };
      const removals: string[] = [];
      for (const photoId of photoIds) {
        delete pendingUploads[photoId];
        if (serverIds[photoId]) removals.push(serverIds[photoId]);
        delete serverIds[photoId];
      }
      // Deleting the pin cascades its photos server-side; the queued removals
      // are belt-and-braces for photos on pins that never synced.
      return { byAnnotation, pendingUploads, serverIds, pendingRemovals: [...s.pendingRemovals, ...removals] };
    });
    persist(snapshot(get));
  },

  reassign: (fromId, toId) => {
    set((s) => {
      const byAnnotation = { ...s.byAnnotation };
      const photos = byAnnotation[fromId];
      if (photos?.length) {
        byAnnotation[toId] = photos;
        delete byAnnotation[fromId];
      }
      const pendingUploads = { ...s.pendingUploads };
      for (const [photoId, annId] of Object.entries(pendingUploads)) {
        if (annId === fromId) pendingUploads[photoId] = toId;
      }
      return { byAnnotation, pendingUploads };
    });
    persist(snapshot(get));
  },

  sync: async (config) => {
    if (get().syncing) return;
    set({ syncing: true });
    try {
      for (const [photoId, annotationId] of Object.entries(get().pendingUploads)) {
        try {
          const file = new File(dir(), `${photoId}.jpg`);
          if (!file.exists) {
            // Local file vanished — nothing to upload; drop the queue entry.
            set((s) => {
              const pendingUploads = { ...s.pendingUploads };
              delete pendingUploads[photoId];
              return { pendingUploads };
            });
            continue;
          }
          const outcome = await uploadAnnotationPhoto(annotationId, await file.base64(), config);
          if (outcome.ok) {
            set((s) => {
              const pendingUploads = { ...s.pendingUploads };
              delete pendingUploads[photoId];
              return { pendingUploads, serverIds: { ...s.serverIds, [photoId]: outcome.serverId } };
            });
          } else if (!outcome.retry) {
            // Rejected outright (bad type/size) — retrying forever won't help.
            set((s) => {
              const pendingUploads = { ...s.pendingUploads };
              delete pendingUploads[photoId];
              return { pendingUploads };
            });
          }
          // retry: the pin hasn't reached the server yet — next tick.
        } catch {
          // Offline — the queue holds.
        }
      }
      for (const serverId of [...get().pendingRemovals]) {
        try {
          if (await deleteAnnotationPhoto(serverId, config)) {
            set((s) => ({ pendingRemovals: s.pendingRemovals.filter((id) => id !== serverId) }));
          }
        } catch {
          // Offline — the queue holds.
        }
      }
      persist(snapshot(get));
    } finally {
      set({ syncing: false });
    }
  },
}));

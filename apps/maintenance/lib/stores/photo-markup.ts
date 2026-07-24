import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { WorkOrderPhotoPhase } from "@/lib/api/work-order-photos";
import {
  expirableOriginals,
  expireOriginal,
  type MarkedPhoto,
  type MarkupStroke,
} from "@/lib/derived/photo-markup";

interface PhotoMarkupState {
  photos: Record<string, MarkedPhoto>;
  add: (workOrderId: string, phase: WorkOrderPhotoPhase, originalUri: string) => string;
  /** Record the flattened copy and the strokes that produced it. */
  saveMarkup: (photoId: string, markedUri: string, strokes: MarkupStroke[]) => void;
  remove: (photoId: string) => Promise<void>;
  /**
   * Retire the originals of photos whose work order has been submitted.
   * Deletes the files, then clears the records. Safe to call on every tick.
   */
  sweepOriginals: (submittedWorkOrderIds: ReadonlySet<string>, nowMs?: number) => Promise<number>;
  forWorkOrder: (workOrderId: string) => MarkedPhoto[];
}

let seq = 0;
function photoId(): string {
  seq += 1;
  return `mp${Date.now().toString(36)}${seq.toString(36)}`;
}

async function deleteQuietly(uri: string | null): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // A file already gone is the outcome we wanted anyway.
  }
}

/**
 * Marked-up work-order photos.
 *
 * Both copies are held until the work order is submitted; then the original is
 * retired and the marked copy stands. The decision of *when* that is safe lives
 * in lib/derived/photo-markup.ts and is tested there — this store only carries
 * it out, because it is the half that deletes a photograph of someone's
 * apartment that cannot be retaken.
 */
export const usePhotoMarkup = create<PhotoMarkupState>()(
  persist(
    (set, get) => ({
      photos: {},

      add: (workOrderId, phase, originalUri) => {
        const id = photoId();
        set((s) => ({
          photos: {
            ...s.photos,
            [id]: {
              photoId: id,
              workOrderId,
              phase,
              originalUri,
              markedUri: null,
              strokes: [],
              capturedAt: Date.now(),
              originalExpiredAt: null,
            },
          },
        }));
        return id;
      },

      saveMarkup: (id, markedUri, strokes) =>
        set((s) => {
          const photo = s.photos[id];
          if (!photo) return s;
          return { photos: { ...s.photos, [id]: { ...photo, markedUri, strokes } } };
        }),

      remove: async (id) => {
        const photo = get().photos[id];
        if (!photo) return;
        await deleteQuietly(photo.originalUri);
        await deleteQuietly(photo.markedUri);
        set((s) => {
          const next = { ...s.photos };
          delete next[id];
          return { photos: next };
        });
      },

      sweepOriginals: async (submittedWorkOrderIds, nowMs = Date.now()) => {
        const due = expirableOriginals(Object.values(get().photos), submittedWorkOrderIds);
        if (due.length === 0) return 0;
        // Files first: a record cleared before its file is gone would orphan
        // bytes on disk with nothing left pointing at them.
        for (const photo of due) await deleteQuietly(photo.originalUri);
        set((s) => {
          const next = { ...s.photos };
          for (const photo of due) {
            const current = next[photo.photoId];
            if (current) next[photo.photoId] = expireOriginal(current, nowMs);
          }
          return { photos: next };
        });
        return due.length;
      },

      forWorkOrder: (workOrderId) =>
        Object.values(get().photos).filter((p) => p.workOrderId === workOrderId),
    }),
    {
      name: "emberly-maintenance-photo-markup",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ photos: s.photos }),
    },
  ),
);

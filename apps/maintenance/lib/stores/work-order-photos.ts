import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { uploadWorkOrderPhoto, type WorkOrderPhotoPhase } from "@/lib/api/work-order-photos";
import {
  enqueuePhoto,
  pruneQueue,
  settlePhoto,
  settlementForOutcome,
  uploadOrder,
  type WorkOrderPhotoQueue,
} from "@/lib/work-order-photo-queue";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Completion photos captured in the work-order close flow. Mirrors the
 * annotation-photos pattern: JPEGs live device-local under
 * Documents/work-order-photos/ and upload to the server on the sync tick,
 * AFTER the pending-closes flush (see app/(tabs)/_layout.tsx). Unlike
 * annotation photos there is no gallery to serve after upload, so a photo's
 * local file is deleted once the server has it. Queue transitions live in
 * lib/work-order-photo-queue.ts (pure, unit-tested).
 */

let seq = 0;

function dir(): Directory {
  const d = new Directory(Paths.document, "work-order-photos");
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

function localFile(photoId: string): File {
  return new File(dir(), `${photoId}.jpg`);
}

function deleteLocalFile(photoId: string): void {
  try {
    localFile(photoId).delete();
  } catch {
    // The queue entry still goes; a stray file is harmless.
  }
}

interface WorkOrderPhotosState {
  /** photo id → queued upload. Persisted; survives restarts offline. */
  pending: WorkOrderPhotoQueue;
  syncing: boolean;
  /** Copy a picked image into the store and queue its upload. Returns the
   *  local photo id. Called at close-submit time, before the close flush. */
  enqueue: (workOrderId: string, sourceUri: string, phase?: WorkOrderPhotoPhase) => Promise<string>;
  /** Push pending uploads. Runs on the sync tick behind the close flush. */
  flush: (config: StaffConfig) => Promise<void>;
  /** Drop stale entries (and their files) — the pending-closes prune, mirrored. */
  prune: (nowMs: number) => void;
}

export const useWorkOrderPhotos = create<WorkOrderPhotosState>()(
  persist(
    (set, get) => ({
      pending: {},
      syncing: false,

      enqueue: async (workOrderId, sourceUri, phase = "completion") => {
        const photoId = `${Date.now()}-${seq++}`;
        new File(sourceUri).copy(localFile(photoId));
        set((s) => ({
          pending: enqueuePhoto(s.pending, { photoId, workOrderId, phase, queuedAt: Date.now() }),
        }));
        return photoId;
      },

      flush: async (config) => {
        if (get().syncing) return;
        set({ syncing: true });
        try {
          for (const entry of uploadOrder(get().pending)) {
            let settlement;
            const file = localFile(entry.photoId);
            if (!file.exists) {
              settlement = "missing" as const;
            } else {
              try {
                const outcome = await uploadWorkOrderPhoto(
                  entry.workOrderId,
                  await file.base64(),
                  entry.phase,
                  config,
                );
                settlement = settlementForOutcome(outcome);
              } catch {
                // Offline — the queue holds, no retry budget spent.
                settlement = "offline" as const;
              }
            }
            const result = settlePhoto(get().pending, entry.photoId, settlement);
            if (result.deleteFile) deleteLocalFile(entry.photoId);
            if (result.queue !== get().pending) set({ pending: result.queue });
          }
        } finally {
          set({ syncing: false });
        }
      },

      prune: (nowMs) => {
        const { queue, droppedIds } = pruneQueue(get().pending, nowMs);
        if (droppedIds.length === 0) return;
        for (const id of droppedIds) deleteLocalFile(id);
        set({ pending: queue });
      },
    }),
    {
      name: "emberly-maintenance-work-order-photos",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ pending: s.pending }),
    },
  ),
);

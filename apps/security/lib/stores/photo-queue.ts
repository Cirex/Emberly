import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { type ScannerConfig, uploadEntryPhoto } from "@/lib/api/scanner";

/**
 * Offline entry-photo upload queue (mirrors iOS ScannerPendingPhotoUploadStore).
 * Captures are enqueued and uploaded opportunistically; failures stay queued and
 * are retried on the next flush (app focus / next scan).
 *
 * Note: photos are referenced by the camera's file URI. For production durability
 * across cache eviction, copy into the document directory — tracked as polish.
 */
const KEY = "emberly_pending_photos";
const MAX_ATTEMPTS = 8;

export interface PendingPhoto {
  id: string;
  entryLogId: string;
  uri: string;
  attempts: number;
}

interface PhotoQueueState {
  pending: PendingPhoto[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  enqueue: (entryLogId: string, uri: string, config: ScannerConfig) => Promise<void>;
  flush: (config: ScannerConfig) => Promise<void>;
}

let seq = 0;
// Guards against overlapping flushes (mount effect + every enqueue both call
// it). Two concurrent flushes would double-upload, and a photo enqueued during
// one flush's awaits would be lost when the stale snapshot overwrote `pending`.
let flushing = false;

async function persist(pending: PendingPhoto[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(pending));
}

export const usePhotoQueue = create<PhotoQueueState>((set, get) => ({
  pending: [],
  hydrated: false,

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY);
    const pending: PendingPhoto[] = raw ? JSON.parse(raw) : [];
    set({ pending, hydrated: true });
  },

  enqueue: async (entryLogId, uri, config) => {
    const item: PendingPhoto = { id: `${Date.now()}-${seq++}`, entryLogId, uri, attempts: 0 };
    const pending = [...get().pending, item];
    set({ pending });
    await persist(pending);
    await get().flush(config);
  },

  flush: async (config) => {
    if (!config.scannerKey || flushing) return;
    flushing = true;
    try {
      const batch = [...get().pending];
      // Per-item outcome, so we reconcile against the LIVE queue afterward
      // instead of clobbering it with a stale snapshot — photos enqueued
      // during the awaits must survive.
      const dropped = new Set<string>();
      const bumped = new Map<string, number>();
      for (const item of batch) {
        try {
          await uploadEntryPhoto(item.entryLogId, item.uri, config);
          dropped.add(item.id); // success → remove
        } catch {
          const attempts = item.attempts + 1;
          if (attempts < MAX_ATTEMPTS) bumped.set(item.id, attempts);
          else dropped.add(item.id); // gave up after MAX_ATTEMPTS
        }
      }
      const next = get()
        .pending.filter((p) => !dropped.has(p.id))
        .map((p) => (bumped.has(p.id) ? { ...p, attempts: bumped.get(p.id) as number } : p));
      set({ pending: next });
      await persist(next);
    } finally {
      flushing = false;
    }
  },
}));

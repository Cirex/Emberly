import { SCANNER_KEY_HEADER } from "@emberly/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import type { ScannerConfig } from "@/lib/api/scanner";

/**
 * Security cameras on the property map — placed and edited in the admin
 * portal only. This device renders their coverage cones but can never move,
 * add, or change one, so the store is a read-only mirror: hydrate from the
 * on-disk cache, then follow the server on every sync tick.
 */
export interface MapCamera {
  id: string;
  x: number;
  y: number;
  /** Facing, degrees clockwise from north (up). */
  direction: number;
  /** Field of view, degrees. */
  fov: number;
  /** Coverage range as a fraction of the page width. */
  range: number;
  active: boolean;
  label: string;
  /** Paired with a UniFi Protect camera server-side — tap for a live view. */
  hasLiveFeed: boolean;
}

const RemoteCameraSchema = z.object({
  id: z.string(),
  label: z.string(),
  normalizedX: z.number(),
  normalizedY: z.number(),
  direction: z.number(),
  fov: z.number(),
  range: z.number(),
  active: z.boolean(),
  hasLiveFeed: z.boolean().optional().default(false),
});

const ListSchema = z.object({ cameras: z.array(RemoteCameraSchema) });

const KEY = "emberly_map_cameras_v2";

interface CamerasState {
  cameras: MapCamera[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Pull the admin-managed camera set. Read-only by design. */
  sync: (config: ScannerConfig) => Promise<void>;
}

export const useCameras = create<CamerasState>((set, get) => ({
  cameras: [],
  hydrated: false,

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY);
    set({ cameras: raw ? JSON.parse(raw) : [], hydrated: true });
  },

  sync: async (config) => {
    try {
      const res = await fetch(`${config.baseUrl}/api/admin/map-cameras`, {
        headers: {
          Authorization: `Bearer ${config.scannerKey}`,
          [SCANNER_KEY_HEADER]: config.scannerKey,
        },
      });
      if (!res.ok) return;
      const cameras = ListSchema.parse(await res.json()).cameras.map((c) => ({
        id: c.id,
        x: c.normalizedX,
        y: c.normalizedY,
        direction: c.direction,
        fov: c.fov,
        range: c.range,
        active: c.active,
        label: c.label,
        hasLiveFeed: c.hasLiveFeed,
      }));
      if (JSON.stringify(cameras) !== JSON.stringify(get().cameras)) {
        set({ cameras });
        void AsyncStorage.setItem(KEY, JSON.stringify(cameras));
      }
    } catch {
      // Offline — the cached set stands until a tick succeeds.
    }
  },
}));

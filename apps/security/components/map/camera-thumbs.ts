import { SCANNER_KEY_HEADER } from "@emberly/core";
import { Skia, type SkImage } from "@shopify/react-native-skia";
import { useEffect, useRef, useState } from "react";
import type { ScannerConfig } from "@/lib/api/scanner";
import type { MapCamera } from "@/lib/stores/cameras";

/**
 * Rolling snapshot thumbnails for every paired camera on the map. Frames are
 * fetched as ~320px JPEGs (the server downscales the 4K originals), decoded to
 * SkImages, and swapped atomically — the previous frame stays on screen until
 * its replacement is ready, so the map never blinks.
 */
const REFRESH_MS = 8_000;
const THUMB_W = 320;

export function useCameraThumbs(
  cameras: MapCamera[],
  config: ScannerConfig,
): { thumbs: Record<string, SkImage>; online: Record<string, boolean> } {
  const [thumbs, setThumbs] = useState<Record<string, SkImage>>({});
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const busy = useRef(false);

  // Key on the id set, not the array identity — the cameras store re-syncs
  // every minute and must not restart the loop when nothing changed.
  const ids = cameras
    .filter((c) => c.active && c.hasLiveFeed)
    .map((c) => c.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!ids || !config.scannerKey) return;
    let cancelled = false;

    const tick = async () => {
      if (busy.current) return; // a slow round shouldn't stack another
      busy.current = true;
      try {
        // Fetched in parallel and committed once. Per-camera setState meant a
        // round of N cameras re-rendered the whole Skia canvas up to 2N times
        // every 8 seconds, rebuilding every cone path and label on each pass.
        const round = await Promise.all(
          ids.split(",").map(async (id) => {
            try {
              const res = await fetch(
                `${config.baseUrl}/api/admin/map-cameras/${id}/snapshot?w=${THUMB_W}&t=${Date.now()}`,
                {
                  headers: {
                    Authorization: `Bearer ${config.scannerKey}`,
                    [SCANNER_KEY_HEADER]: config.scannerKey,
                  },
                },
              );
              if (!res.ok) throw new Error(`snapshot ${res.status}`);
              const bytes = new Uint8Array(await res.arrayBuffer());
              const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
              if (!image) throw new Error("decode failed");
              return { id, image };
            } catch {
              // Keep the stale frame — a dead thumbnail reads worse than an old
              // one — but flip the indicator so the guard knows.
              return { id, image: null };
            }
          }),
        );
        if (cancelled) return;
        setThumbs((prev) => {
          const next = { ...prev };
          let moved = false;
          for (const { id, image } of round) {
            if (image) {
              next[id] = image;
              moved = true;
            }
          }
          return moved ? next : prev; // an all-failed round re-renders nothing
        });
        setOnline((prev) => {
          const next = { ...prev };
          let moved = false;
          for (const { id, image } of round) {
            const up = image !== null;
            if (next[id] !== up) {
              next[id] = up;
              moved = true;
            }
          }
          return moved ? next : prev;
        });
      } finally {
        busy.current = false;
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ids, config.baseUrl, config.scannerKey]);

  return { thumbs, online };
}

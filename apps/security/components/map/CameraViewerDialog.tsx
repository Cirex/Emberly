import { Ionicons } from "@expo/vector-icons";
import { SCANNER_KEY_HEADER } from "@emberly/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, Text, View } from "react-native";
import type { ScannerConfig } from "@/lib/api/scanner";
import type { MapCamera } from "@/lib/stores/cameras";

/**
 * Live view of a paired security camera. The server proxies UniFi Protect
 * snapshots (the cloud key never touches this device), so "live" here is a
 * fresh frame every few seconds — plenty for a guard checking a gate.
 */
const REFRESH_MS = 4_000;
/** Server-side downscale — the dialog never needs the 4K original. */
const FRAME_W = 960;

export function CameraViewerDialog({
  camera,
  config,
  onClose,
}: {
  camera: MapCamera;
  config: ScannerConfig;
  onClose: () => void;
}) {
  const frameUri = useCallback(
    (t: number) => `${config.baseUrl}/api/admin/map-cameras/${camera.id}/snapshot?w=${FRAME_W}&t=${t}`,
    [config.baseUrl, camera.id],
  );

  // Double buffer: the shown frame only advances when its replacement has
  // fully loaded, so refreshes never flash white. `stale` marks a refresh
  // that failed — the old frame stays up with a warning instead.
  const [shownUri, setShownUri] = useState<string | null>(null);
  const [loadingUri, setLoadingUri] = useState(() => frameUri(Date.now()));
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setLoadingUri(frameUri(Date.now())), REFRESH_MS);
    return () => clearInterval(interval);
  }, [frameUri]);

  // A frame is cached until the next refresh replaces it. <Image> diffs its
  // `source` by identity, so a fresh object literal each render would make it
  // drop and re-request the frame already on screen — every parent re-render
  // (a store tick, a sibling's state) re-fetching what we're already showing.
  // Memoising both sources pins each frame until its URI actually changes.
  const headers = useMemo(
    () => ({
      Authorization: `Bearer ${config.scannerKey}`,
      [SCANNER_KEY_HEADER]: config.scannerKey,
    }),
    [config.scannerKey],
  );
  const shownSource = useMemo(
    () => (shownUri ? { uri: shownUri, headers } : null),
    [shownUri, headers],
  );
  const loadingSource = useMemo(() => ({ uri: loadingUri, headers }), [loadingUri, headers]);

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(9,27,84,0.32)",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        {/* Pressable-in-Pressable: taps inside the card must not dismiss. */}
        <Pressable
          onPress={() => {}}
          className="bg-white dark:bg-night-surface"
          style={{ width: "100%", maxWidth: 640, borderRadius: 22, padding: 18, gap: 12 }}
        >
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center" style={{ gap: 9 }}>
              <View
                className="items-center justify-center rounded-full"
                style={{ width: 30, height: 30, backgroundColor: "rgba(91,124,153,0.18)" }}
              >
                <Ionicons name="videocam" size={15} color="#5B7C99" />
              </View>
              <Text className="text-navy dark:text-white" style={{ fontSize: 17, fontWeight: "700" }}>
                {camera.label || "Camera"}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color="#70788F" />
            </Pressable>
          </View>

          <View
            style={{
              borderRadius: 14,
              overflow: "hidden",
              aspectRatio: 16 / 9,
              backgroundColor: "rgba(9,27,84,0.06)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {!camera.hasLiveFeed ? (
              <Text className="text-slate dark:text-white/60" style={{ fontSize: 13, fontWeight: "600" }}>
                No live feed paired to this camera
              </Text>
            ) : (
              <>
                {/* The last good frame stays put underneath… */}
                {shownSource ? (
                  <Image
                    source={shownSource}
                    style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
                    resizeMode="cover"
                    fadeDuration={0}
                  />
                ) : null}
                {/* …while the next one loads invisibly on top and swaps in
                    only once decoded — no white flash between frames. */}
                <Image
                  source={loadingSource}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
                  resizeMode="cover"
                  fadeDuration={0}
                  onLoad={() => {
                    setShownUri(loadingUri);
                    setStale(false);
                  }}
                  onError={() => setStale(true)}
                />
                {!shownUri && !stale ? <ActivityIndicator color="#5B7C99" /> : null}
                {!shownUri && stale ? (
                  <Text className="text-slate dark:text-white/60" style={{ fontSize: 13, fontWeight: "600" }}>
                    Snapshot unavailable — retrying…
                  </Text>
                ) : null}
              </>
            )}
          </View>

          {camera.hasLiveFeed ? (
            <View className="flex-row items-center" style={{ gap: 6 }}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: stale && shownUri ? "#E3B23A" : "#D1382E",
                }}
              />
              <Text className="text-slate dark:text-white/60" style={{ fontSize: 11.5, fontWeight: "700", letterSpacing: 0.6 }}>
                {stale && shownUri
                  ? "CONNECTION LOST · RETRYING"
                  : `LIVE · REFRESHES EVERY ${Math.round(REFRESH_MS / 1000)}S`}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

import { Tabs } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";
import { useAnnotationPhotos } from "@/lib/stores/annotation-photos";
import { useAnnotations } from "@/lib/stores/annotations";
import { useCameras } from "@/lib/stores/cameras";
import { useTags } from "@/lib/stores/tags";
import { isScannerConfigured, useConfig } from "@/lib/stores/config";
import { useUnits } from "@/lib/stores/units";

const REFRESH_MS = 60_000;

/**
 * Keeps the cached data live without anyone asking: a quiet re-sync when the
 * app comes to the foreground and every minute while it's up. Units skip the
 * state write when the server has nothing new; annotations push their queued
 * edits and pull the shared security layer, so pins placed in the admin
 * portal appear here (and vice versa) within a tick. QR verification stays
 * the only on-demand server call in the app.
 */
function useServerSync() {
  const hydrated = useConfig((s) => s.hydrated);
  const scannerKey = useConfig((s) => s.scannerKey);
  const baseUrl = useConfig((s) => s.baseUrl);

  useEffect(() => {
    if (!hydrated || !isScannerConfigured({ scannerKey })) return;
    const config = { baseUrl, scannerKey };
    const tick = () => {
      void useUnits.getState().refresh(config);
      // Photos ride behind the pins: a fresh pin must reach the server (and
      // trade up to its server id) before its photos can attach to it.
      void useAnnotations
        .getState()
        .sync(config)
        .then(() => useAnnotationPhotos.getState().sync(config));
      void useCameras.getState().sync(config);
      void useTags.getState().sync(config);
    };

    tick();
    const interval = setInterval(tick, REFRESH_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") tick();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [hydrated, scannerKey, baseUrl]);
}

export default function TabsLayout() {
  useServerSync();

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: "transparent" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Tenants" }} />
      <Tabs.Screen name="property-map" options={{ title: "Property Map" }} />
      <Tabs.Screen name="scanner" options={{ title: "Scanner" }} />
      <Tabs.Screen name="guest-passes" options={{ title: "Guest Passes" }} />
    </Tabs>
  );
}

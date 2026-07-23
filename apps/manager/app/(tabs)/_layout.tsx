// Side-effect barrel: importing it arms every feature store's registerSync
// call, so runSyncTick below has its participants before the first tick.
import "@/lib/sync-participants";

import { Tabs } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AppState, useWindowDimensions } from "react-native";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";
import { RAIL_WIDTH, SidebarRail } from "@/components/ui/SidebarRail";
import { isSignedIn, useConfig } from "@/lib/stores/config";
import { runSyncTick } from "@/lib/sync-registry";

/** iPad threshold — the same breakpoint every screen switches its layout on. */
const WIDE_MIN_WIDTH = 1040;

const REFRESH_MS = 60_000;

/**
 * Keeps the cached data live without anyone asking: a quiet re-sync when the
 * app comes to the foreground and every minute while it's up — the exact
 * cadence of the maintenance app. What syncs is whatever registered via
 * lib/sync-registry.ts (see lib/sync-participants.ts); each store handles its
 * own first-run vs quiet-refresh split and skips its state write when the
 * server has nothing new, so a quiet tick re-renders nothing.
 */
function useServerSync() {
  const hydrated = useConfig((s) => s.hydrated);
  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);

  useEffect(() => {
    if (!hydrated || !isSignedIn({ token })) return;
    const config = { baseUrl, token };
    const tick = () => {
      void runSyncTick(config);
    };

    // First run included: the participants' own cold-cache branches decide
    // whether this shows a spinner (loadAll) or refreshes silently.
    tick();
    const interval = setInterval(tick, REFRESH_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") tick();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [hydrated, token, baseUrl]);
}

export default function TabsLayout() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_MIN_WIDTH;
  useServerSync();

  return (
    <Tabs
      // The rail replaces the bottom bar on tablet; the phone keeps the
      // floating capsule. The rail overlays the left edge, so the scene is
      // cleared of it by padding the scene container the same width.
      tabBar={(props) => (wide ? <SidebarRail {...props} /> : <FloatingTabBar {...props} />)}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: "transparent", paddingLeft: wide ? RAIL_WIDTH : 0 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t("tabs.today") }} />
      <Tabs.Screen name="leasing" options={{ title: t("tabs.leasing") }} />
      <Tabs.Screen name="delinquency" options={{ title: t("tabs.money") }} />
      <Tabs.Screen name="work" options={{ title: t("work.title") }} />
      <Tabs.Screen name="utilities" options={{ title: t("tabs.utilities") }} />
      <Tabs.Screen name="property-map" options={{ title: t("tabs.map") }} />
    </Tabs>
  );
}

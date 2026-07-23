import { Tabs } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";
import { registerForEmergencyPush } from "@/lib/push";
import { useAnnotationPhotos } from "@/lib/stores/annotation-photos";
import { useAnnotations } from "@/lib/stores/annotations";
import { isSignedIn, useConfig } from "@/lib/stores/config";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { usePendingEdits } from "@/lib/stores/pending-edits";
import { usePm } from "@/lib/stores/pm";
import { useWorkOrderPhotos } from "@/lib/stores/work-order-photos";
import { useTags } from "@/lib/stores/tags";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { useWorkOrderTranslationSync } from "@/lib/translation/use-translated";

const REFRESH_MS = 60_000;

/**
 * Keeps the cached data live without anyone asking: a quiet re-sync when the
 * app comes to the foreground and every minute while it's up. The stores
 * skip their state writes when the server has nothing new, so a quiet tick
 * re-renders nothing. Annotations push their queued edits and pull the shared
 * layer, so pins placed in the admin portal appear here (and vice versa)
 * within a tick.
 */
function useServerSync() {
  const hydrated = useConfig((s) => s.hydrated);
  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);

  useEffect(() => {
    if (!hydrated || !isSignedIn({ token })) return;
    const config = { baseUrl, token };
    const CLOSED = new Set(["Closed", "Completed", "Cancelled", "Canceled"]);
    const tick = () => {
      void useWorkOrders
        .getState()
        .refresh(config)
        .then(() => {
          // Pending closes ride behind the mirror: retry un-acked ones, retire
          // the ones the sync has confirmed closed. Completion photos flush
          // AFTER the close flush — the work-order row exists server-side
          // either way, but this keeps a photo from racing its own close.
          const closes = usePendingCloses.getState();
          void closes
            .flush(config)
            .then(() => useWorkOrderPhotos.getState().flush(config))
            .then(() => useWorkOrderPhotos.getState().prune(Date.now()));
          const closedIds = new Set(
            useWorkOrders
              .getState()
              .workOrders.filter((wo) => CLOSED.has(wo.status))
              .map((wo) => wo.resman_work_order_id),
          );
          closes.prune(closedIds, Date.now());
          // Pending edits retire the same way: retry un-acked, drop absorbed.
          const edits = usePendingEdits.getState();
          void edits.flush(config);
          edits.prune(useWorkOrders.getState().workOrders, Date.now());
        });
      void useUnits.getState().refresh(config);
      // Photos ride behind the pins: a fresh pin must reach the server (and
      // trade up to its server id) before its photos can attach to it.
      void useAnnotations
        .getState()
        .sync(config)
        .then(() => useAnnotationPhotos.getState().sync(config));
      void useTags.getState().sync(config);
      // Preventive rounds follow the same beat; the store skips its state
      // write when the server round is unchanged, so a quiet tick is free.
      void usePm.getState().refresh(config);
    };

    // First run on a cold cache shows the spinner path instead of a silent
    // refresh, so the screens have something honest to render.
    if (useWorkOrders.getState().workOrders.length === 0) {
      void useWorkOrders.getState().loadAll(config);
    }
    if (useUnits.getState().allUnits.length === 0) {
      void useUnits.getState().loadAll(config);
    }
    if (usePm.getState().templates.length === 0) {
      void usePm.getState().loadAll(config);
    }

    // Emergency push registration for a device already signed in at launch.
    // Cheap and guarded once-per-session internally, so re-running the effect
    // (or the sign-in screen having just registered) costs nothing.
    void registerForEmergencyPush(config);

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
  useServerSync();
  // Pre-translate work-order prose on-device as it syncs (no-op in English).
  useWorkOrderTranslationSync();

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: "transparent" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t("tabs.myDay") }} />
      <Tabs.Screen name="work-orders" options={{ title: t("tabs.workOrders") }} />
      <Tabs.Screen name="make-ready" options={{ title: t("tabs.makeReady") }} />
      <Tabs.Screen name="property-map" options={{ title: t("tabs.map") }} />
    </Tabs>
  );
}

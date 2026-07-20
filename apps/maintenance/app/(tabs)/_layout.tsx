import { Tabs } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";
import { useAnnotationPhotos } from "@/lib/stores/annotation-photos";
import { useAnnotations } from "@/lib/stores/annotations";
import { isSignedIn, useConfig } from "@/lib/stores/config";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { usePendingEdits } from "@/lib/stores/pending-edits";
import { useTags } from "@/lib/stores/tags";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";

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
          // the ones the sync has confirmed closed.
          const closes = usePendingCloses.getState();
          void closes.flush(config);
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
    };

    // First run on a cold cache shows the spinner path instead of a silent
    // refresh, so the screens have something honest to render.
    if (useWorkOrders.getState().workOrders.length === 0) {
      void useWorkOrders.getState().loadAll(config);
    }
    if (useUnits.getState().allUnits.length === 0) {
      void useUnits.getState().loadAll(config);
    }

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
  useServerSync();

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: "transparent" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "My Day" }} />
      <Tabs.Screen name="work-orders" options={{ title: "Work Orders" }} />
      <Tabs.Screen name="make-ready" options={{ title: "Make Ready" }} />
      <Tabs.Screen name="property-map" options={{ title: "Map" }} />
    </Tabs>
  );
}

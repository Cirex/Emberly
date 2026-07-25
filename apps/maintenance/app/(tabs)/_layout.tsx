import { Tabs } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";
import { registerForEmergencyPush, useWorkOrdersChangedPush } from "@/lib/push";
import { useAnnotationPhotos } from "@/lib/stores/annotation-photos";
import { useAnnotations } from "@/lib/stores/annotations";
import { isSignedIn, useConfig } from "@/lib/stores/config";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { usePendingEdits } from "@/lib/stores/pending-edits";
import { usePm } from "@/lib/stores/pm";
import { useWorkOrderPhotos } from "@/lib/stores/work-order-photos";
import { usePhotoMarkup } from "@/lib/stores/photo-markup";
import { useTags } from "@/lib/stores/tags";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { useWorkOrderTranslationSync } from "@/lib/translation/use-translated";

/**
 * Poll interval. Short on purpose: the work-order refresh asks only for what
 * changed since its last read (`?updated_since=`), so a quiet tick is two tiny
 * responses rather than the whole board. This is the FLOOR — the sync worker
 * also pushes a silent wake-up the moment it writes a change, which is what
 * makes the app feel live. The poll exists because push is best-effort: a tech
 * can decline the notification permission, and iOS throttles silent delivery.
 *
 * THIS INTERVAL IS ONLY CHEAP BECAUSE THE DELTA READ WORKS. Measured against
 * the live mirror (4,067 rows): a full fetch is 3.78 MB over 21 paged requests.
 * If a tick ever fetched everything again, this interval would move
 * ~640 GB/month PER DEVICE — three phones would blow through a Supabase Pro
 * plan's included egress on work orders alone. The old 60s full poll was
 * already ~160 GB/month/device.
 *
 * So the delta is not an optimization, it is what makes the interval affordable,
 * and it depends on resman_work_orders.updated_at meaning "this row changed"
 * (deltas/2026-07-24-work-order-change-detection.sql). Revert that trigger and
 * every tick silently becomes a full download again. Before raising the
 * frequency, check that quiet ticks are still returning empty.
 */
const REFRESH_MS = 15_000;

/**
 * Keeps the cached data live without anyone asking: a quiet re-sync when the
 * app comes to the foreground, on a short interval while it's up, and
 * immediately when the server pushes word that something changed. The stores
 * skip their state writes when the server has nothing new, so a quiet tick
 * re-renders nothing. Annotations push their queued edits and pull the shared
 * layer, so pins placed in the admin portal appear here (and vice versa)
 * within a tick.
 */
function useServerSync() {
  const hydrated = useConfig((s) => s.hydrated);
  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);
  // Held in a ref so the push listener can fire the CURRENT tick without
  // re-subscribing every time the config object identity changes.
  const tickRef = useRef<() => void>(() => {});

  // A silent push means the server already knows something moved — sync now
  // instead of waiting out the interval.
  useWorkOrdersChangedPush(hydrated && isSignedIn({ token }), () => tickRef.current());

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
          // A work order the mirror reports closed has been submitted, so the
          // untouched originals of its marked-up photos can retire — the marked
          // copy is what was uploaded and what stands. Safe every tick; the
          // sweep refuses to expire a photo that has no marked copy to replace
          // it (lib/derived/photo-markup.ts).
          void usePhotoMarkup.getState().sweepOriginals(closedIds);
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

    // Publish the tick bound to THIS config, so a push that arrives later runs
    // the current one rather than a stale closure.
    tickRef.current = tick;
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

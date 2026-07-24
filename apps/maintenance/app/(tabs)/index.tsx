import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useColorScheme } from "nativewind";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Reanimated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { MiniPathMap } from "@/components/my-day/MiniPathMap";
import { MyWeekPanel } from "@/components/my-day/MyWeekPanel";
import { matchesDisplayMode } from "@/lib/derived/filtering";
import { greetingKeyFor, techMatches, urgentTrade } from "@/lib/derived/my-path";
import { buildMyWeek } from "@/lib/derived/my-week";
import { parseAll } from "@/lib/derived/parse";
import { TRADE_TINT, tagIconName, tagTint } from "@/lib/derived/tags";
import { workOrderStatusColor } from "@/lib/derived/status";
import { abbreviatedDate } from "@/lib/derived/time";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { activeLocale } from "@/lib/i18n";
import { isSignedIn, useConfig } from "@/lib/stores/config";
import { useMyDay, type MyDayStop } from "@/lib/stores/my-day";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { HAIRLINE, MUTED, NAVY, OLIVE, OLIVE_TEXT, screenHPad } from "@/theme/tokens";

const GREEN = "#33A666";
const RED = "#D1382E";
const BAND = "rgba(9,27,84,0.05)";
const UP_NEXT = "#2563B4";

const FLOWER = require("@/assets/logo-flower.png");


/**
 * My Day — the signed-in technician's path view, in the approved Option 2
 * (edge-to-edge) treatment: a two-line large-title greeting, a bare inline
 * metric strip, the path map as a full-bleed hero with floating glass
 * capsules, and containerless full-width rows separated by hairlines. Done
 * stops collapse into an expandable "Done today" band that doubles as the
 * separator before the queue. Swipe left closes a stop, swipe right in the
 * queue adds a unit — unchanged.
 */
export default function MyDayScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pad = screenHPad(width);
  const router = useRouter();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";

  const admin = useConfig((s) => s.admin);
  const token = useConfig((s) => s.token);
  // The simulator's dev-token session signs in as "Dev Preview", which is no
  // technician — demo the path as a real tech there. Real sign-ins unaffected.
  const staffName = (admin?.displayName === "Dev Preview" ? "Quintez Harden" : admin?.displayName?.trim()) ?? "";
  const firstName = staffName.split(/\s+/)[0] || "there";

  const workOrders = useWorkOrders((s) => s.workOrders);
  const dataVersion = useWorkOrders((s) => s.dataVersion);
  const pending = usePendingCloses((s) => s.pending);
  const queueClose = usePendingCloses((s) => s.queueClose);
  const removePending = usePendingCloses((s) => s.remove);

  const day = useMyDay();

  const nowMs = Date.now();

  // Parse the full mirror once per data change: byId serves the recap rows
  // (whose base rows may have left the open set), openAll drives everything.
  const parsed = useMemo(() => parseAll(workOrders), [dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(parsed.map((wo) => [wo.id, wo])), [parsed]);
  const openAll = useMemo(() => parsed.filter((wo) => matchesDisplayMode(wo, "open")), [parsed]);

  const pendingIds = useMemo(() => new Set(Object.keys(pending)), [pending]);

  // Reconcile the path against the live mirror on every data/pending change.
  useEffect(() => {
    if (!isSignedIn({ token })) return;
    day.reconcile({ openWorkOrders: openAll, staffName, pendingClosedIds: pendingIds, nowMs: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAll, staffName, pendingIds, token]);

  const mine = useMemo(
    () => openAll.filter((wo) => techMatches(staffName, wo) && !pendingIds.has(wo.id)),
    [openAll, staffName, pendingIds],
  );
  const urgentCount = useMemo(() => mine.filter((wo) => urgentTrade(wo) !== null).length, [mine]);

  const pathUnits = useMemo(() => new Set(day.stops.filter((s) => !s.isDone).map((s) => s.unitNumber)), [day.stops]);
  const queue = useMemo(() => {
    const rows = mine.filter((wo) => !pathUnits.has(wo.unitNumber.trim()));
    rows.sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0));
    return rows;
  }, [mine, pathUnits]);

  const pendingStops = useMemo(() => day.stops.filter((s) => !s.isDone), [day.stops]);
  const doneStops = useMemo(() => day.stops.filter((s) => s.isDone), [day.stops]);
  // "Completed Today" counts the work orders closed today across the done
  // stops (the recap that holds until rollover), not a fraction of the path.
  const completedToday = useMemo(
    () => doneStops.reduce((n, s) => n + s.workOrderIds.length, 0),
    [doneStops],
  );
  // "Up Next" emphasis goes to the first pending stop that isn't the pinned
  // emergency — the one the tech actually walks to next by choice.
  const upNextId = useMemo(
    () => pendingStops.find((s) => s.addedBy !== "emergency")?.id ?? null,
    [pendingStops],
  );
  const [doneOpen, setDoneOpen] = useState(false);

  // Undo toast for swipe actions.
  const [toast, setToast] = useState<{ label: string; undo: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (label: string, undo: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ label, undo });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  const config = { baseUrl: useConfig.getState().baseUrl, token };

  const closeStop = (stop: MyDayStop) => {
    const ids = stop.workOrderIds.filter((id) => byId.get(id) && !pendingIds.has(id));
    for (const id of ids) void queueClose(id, "", config);
    day.setDone(stop.id, true);
    showToast(t("myDay.toastClosed", { count: ids.length, unit: stop.unitNumber }), () => {
      for (const id of ids) removePending(id);
      day.setDone(stop.id, false);
    });
  };

  const addToPath = (wo: ParsedWorkOrder) => {
    const unit = wo.unitNumber.trim();
    const ids = mine.filter((m) => m.unitNumber.trim() === unit).map((m) => m.id);
    day.addUnit(unit, ids.length > 0 ? ids : [wo.id]);
    const position = day.stops.filter((s) => !s.isDone).length + 1;
    showToast(t("myDay.toastAdded", { position }), () => {
      const added = useMyDay.getState().stops.find((s) => s.unitNumber === unit && s.addedBy === "manual");
      if (added) day.removeStop(added.id);
    });
  };

  const openInMap = () => router.push({ pathname: "/(tabs)/property-map", params: { path: "1" } });

  // ── My Day ⇄ My Week pager
  const pagerRef = useRef<ScrollView>(null);
  const showWeek = useCallback(() => pagerRef.current?.scrollTo({ x: width, animated: true }), [width]);
  const showDay = useCallback(() => pagerRef.current?.scrollTo({ x: 0, animated: true }), []);
  // A width change (rotation, split view) would leave the pager parked mid-page.
  useEffect(() => {
    pagerRef.current?.scrollTo({ x: 0, animated: false });
  }, [width]);

  // Rebuilding is instant — the spinner is held briefly so the gesture reads as
  // having done something rather than snapping back with no acknowledgement.
  const [rebuilding, setRebuilding] = useState(false);
  const rebuildPath = useCallback(() => {
    setRebuilding(true);
    day.rebuild({ openWorkOrders: openAll, staffName, pendingClosedIds: pendingIds, nowMs: Date.now() });
    setTimeout(() => setRebuilding(false), 450);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAll, staffName, pendingIds]);

  const myWeek = useMemo(
    () =>
      buildMyWeek({
        workOrders: parsed,
        staffName,
        nowMs,
        onRouteToday: pendingStops.length,
        urgentToday: urgentCount,
      }),
    // nowMs is a render-time clock; keying on the data is what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parsed, staffName, pendingStops.length, urgentCount],
  );

  const header = (
    <View>
      {/* Large-title greeting — two lines, the screen's identity, with the
          Emberly mark leading it. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
          paddingHorizontal: pad,
        }}
      >
        <Image source={FLOWER} style={{ width: 58, height: 58, alignSelf: "center" }} resizeMode="contain" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 28, fontWeight: "800", letterSpacing: -0.6, lineHeight: 32 }}
          >
            {t(`myDay.greeting.${greetingKeyFor(nowMs)}`)},{"\n"}
            {firstName}
          </Text>
          <Text className="text-slate dark:text-white/70" style={{ fontSize: 12.5, marginTop: 4 }}>
            {new Date(nowMs).toLocaleDateString(activeLocale(), { weekday: "long", month: "short", day: "numeric" })} ·{" "}
            {t("myDay.assigned", { count: mine.length })}
          </Text>
        </View>
        <AccountMenu />
      </View>

      {/* Inline metric strip — bare numbers, hairline dividers, no boxes. */}
      <View style={{ flexDirection: "row", paddingHorizontal: pad, marginTop: 16, marginBottom: 14 }}>
        <Metric value={String(mine.length)} label={t("myDay.metrics.assigned")} />
        <Metric value={String(urgentCount)} label={t("myDay.metrics.urgent")} tint="#B05E14" divider />
        <Metric value={String(completedToday)} label={t("myDay.metrics.completedToday")} tint={GREEN} divider />
      </View>

      {/* Hero: the path map, edge to edge, chrome floating on top. */}
      <Pressable onPress={openInMap} accessibilityRole="button" accessibilityLabel={t("myDay.openPathInMap")}>
        <MiniPathMap
          height={200}
          radius={0}
          stops={day.stops.map((s) => ({
            unitNumber: s.unitNumber,
            isDone: s.isDone,
            isEmergency: s.addedBy === "emergency",
          }))}
        />
        <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
          <GlassPill style={{ position: "absolute", top: 12, left: pad - 6 }} dark={dark}>
            <Text
              className="text-navy dark:text-white"
              style={{ fontSize: 10.5, fontWeight: "800", letterSpacing: 0.8 }}
            >
              {t("myDay.pathPill", { count: day.stops.length })}
            </Text>
          </GlassPill>
          <View style={{ position: "absolute", right: pad - 6, bottom: 12, flexDirection: "row", gap: 8 }}>
            {/* Rebuild used to sit here as a button. It is now the pull-to-
                refresh on the list below — the gesture a tech already reaches
                for — which frees the spot for the way into My Week. */}
            <GlassPill dark={dark} onPress={showWeek}>
              <Ionicons name="stats-chart" size={12} color={OLIVE_TEXT} />
              <Text style={{ fontSize: 12, fontWeight: "700", color: OLIVE_TEXT }}>{t("myWeek.open")}</Text>
              <Ionicons name="chevron-forward" size={11} color={OLIVE_TEXT} />
            </GlassPill>
            <Pressable
              onPress={openInMap}
              accessibilityRole="button"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 999,
                backgroundColor: "rgba(162,169,33,0.92)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.5)",
              }}
            >
              <Ionicons name="map-outline" size={12} color="#FFFFFF" />
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#FFFFFF" }}>{t("myDay.map")}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>

      {/* Stop list — no container, full-bleed rows. */}
      <View>
        {day.stops.length === 0 ? (
          <Text
            className="text-muted dark:text-white/50"
            style={{ fontSize: 12.5, textAlign: "center", padding: 18, borderTopWidth: 1, borderTopColor: HAIRLINE }}
          >
            {staffName ? t("myDay.emptySignedIn") : t("myDay.emptySignedOut")}
          </Text>
        ) : (
          <>
            {pendingStops.map((stop, i) => (
              <StopRow
                key={stop.id}
                stop={stop}
                number={stop.addedBy === "emergency" ? null : pendingStops.slice(0, i).filter((s) => s.addedBy !== "emergency").length + 1}
                upNext={stop.id === upNextId}
                pad={pad}
                byId={byId}
                nowMs={nowMs}
                onToggleDone={() => day.setDone(stop.id, true)}
                onOpen={() => {
                  const primary = stop.workOrderIds[0];
                  if (primary) router.push(`/work-order/${primary}`);
                }}
                onClose={() => closeStop(stop)}
              />
            ))}
            {doneStops.length > 0 ? (
              <>
                <Pressable
                  onPress={() => setDoneOpen((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: doneOpen }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: pad,
                    paddingVertical: 10,
                    borderTopWidth: 1,
                    borderTopColor: HAIRLINE,
                    borderBottomWidth: doneOpen ? 0 : 1,
                    borderBottomColor: HAIRLINE,
                    backgroundColor: BAND,
                  }}
                >
                  <Ionicons name="checkmark" size={13} color={GREEN} />
                  <Text style={{ fontSize: 11, fontWeight: "700", color: GREEN }}>
                    {t("myDay.doneToday", { count: doneStops.length })}
                  </Text>
                  <Text
                    className="text-muted dark:text-white/50"
                    numberOfLines={1}
                    style={{ fontSize: 11, flex: 1 }}
                  >
                    {doneStops.map((s) => s.unitNumber).join(", ")} · {t("myDay.syncingToResman")}
                  </Text>
                  <Ionicons name={doneOpen ? "chevron-up" : "chevron-down"} size={12} color={MUTED} />
                </Pressable>
                {doneOpen
                  ? doneStops.map((stop) => (
                      <DoneRow
                        key={stop.id}
                        stop={stop}
                        pad={pad}
                        byId={byId}
                        nowMs={nowMs}
                        onToggleDone={() => day.setDone(stop.id, false)}
                        onOpen={() => {
                          const primary = stop.workOrderIds[0];
                          if (primary) router.push(`/work-order/${primary}`);
                        }}
                      />
                    ))
                  : null}
              </>
            ) : null}
          </>
        )}
      </View>

      <Text
        className="text-muted dark:text-white/50"
        style={{ fontSize: 11, fontWeight: "800", letterSpacing: 1.1, marginTop: 16, marginBottom: 6, marginHorizontal: pad }}
      >
        {t("myDay.queueHeader", { count: queue.length })}
      </Text>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {/*
        My Day and My Week are two pages of one horizontal pager, driven only by
        the pills — swipe is deliberately off. The stop and queue rows are
        themselves horizontally swipeable (close a stop, add to path), and a
        swipeable pager would fight them for every drag; losing "swipe to close"
        to gain "swipe to My Week" would be a bad trade.
      */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
      >
        <View style={{ width }}>
          <FlatList
            data={queue}
            keyExtractor={(wo) => wo.id}
            contentContainerStyle={{
              paddingTop: insets.top + 10,
              paddingBottom: insets.bottom + 110,
            }}
            ListHeaderComponent={header}
            windowSize={7}
            refreshControl={
              <RefreshControl
                refreshing={rebuilding}
                onRefresh={rebuildPath}
                tintColor={MUTED}
                progressViewOffset={insets.top}
              />
            }
            ListEmptyComponent={
              <Text className="text-muted dark:text-white/50" style={{ fontSize: 12.5, textAlign: "center", padding: 16 }}>
                {t("myDay.queueEmpty")}
              </Text>
            }
            renderItem={({ item }) => (
              <QueueRow
                wo={item}
                pad={pad}
                nowMs={nowMs}
                onOpen={() => router.push(`/work-order/${item.id}`)}
                onAdd={() => addToPath(item)}
              />
            )}
          />
        </View>
        <View style={{ width }}>
          <MyWeekPanel
            week={myWeek}
            pad={pad}
            topInset={insets.top}
            bottomInset={insets.bottom}
            onBack={showDay}
          />
        </View>
      </ScrollView>

      {toast ? (
        <View
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 84, alignItems: "center" }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              backgroundColor: "rgba(9,27,84,0.94)",
              borderRadius: 999,
              paddingVertical: 9,
              paddingHorizontal: 18,
              shadowColor: NAVY,
              shadowOpacity: 0.35,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 10 },
            }}
          >
            <Text style={{ color: "#FFFFFF", fontSize: 12.5, fontWeight: "600" }}>{toast.label}</Text>
            <Pressable
              onPress={() => {
                toast.undo();
                setToast(null);
              }}
              accessibilityRole="button"
            >
              <Text style={{ color: "#D8DE7A", fontSize: 12.5, fontWeight: "800" }}>{t("myDay.undo")}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** One bare metric: big tinted number over a small label, hairline divider. */
function Metric({ value, label, tint, divider }: { value: string; label: string; tint?: string; divider?: boolean }) {
  return (
    <View
      style={{
        flex: 1,
        borderLeftWidth: divider ? 1 : 0,
        borderLeftColor: HAIRLINE,
        paddingLeft: divider ? 16 : 0,
      }}
    >
      <Text style={{ fontSize: 24, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"], color: tint ?? NAVY }}>
        {value}
      </Text>
      <Text className="text-slate dark:text-white/60" style={{ fontSize: 10, fontWeight: "600", marginTop: 1 }}>
        {label}
      </Text>
    </View>
  );
}

/** Small glass capsule floating over the hero map (label or button). */
function GlassPill({
  children,
  onPress,
  style,
  dark,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: object;
  dark: boolean;
}) {
  const body = (
    <View style={[{ borderRadius: 999, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.6)" }, style]}>
      <BlurView intensity={dark ? 30 : 22} tint={dark ? "dark" : "light"} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: dark ? "rgba(20,26,46,0.45)" : "rgba(255,255,255,0.55)",
        }}
      >
        {children}
      </View>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {body}
    </Pressable>
  );
}

/** Green "Close" panel revealed by swiping a stop row left. */
const ACTION_W = 92;

/**
 * Green "Close" panel revealed by swiping a stop row left. It slides in from
 * the right edge tracking the drag (translation is negative as the row opens),
 * so it's progressively uncovered instead of snapping to full width the
 * instant the gesture starts. `translation` is the swipe's shared value.
 */
function CloseAction({ translation }: { translation: SharedValue<number> }) {
  const { t } = useTranslation();
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.value + ACTION_W }],
  }));
  return (
    <Reanimated.View
      style={[
        { width: ACTION_W, backgroundColor: GREEN, alignItems: "center", justifyContent: "center", gap: 2 },
        style,
      ]}
    >
      <Ionicons name="checkmark" size={18} color="#FFFFFF" />
      <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "800" }}>{t("myDay.close")}</Text>
    </Reanimated.View>
  );
}

/** Olive "+ Add" panel revealed by swiping a queue row right (left-side
 *  actions; translation is positive as it opens, so the panel starts one
 *  width off-screen to the left and slides in with the drag). */
function AddAction({ translation }: { translation: SharedValue<number> }) {
  const { t } = useTranslation();
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.value - ACTION_W }],
  }));
  return (
    <Reanimated.View
      style={[
        { width: ACTION_W, backgroundColor: OLIVE, alignItems: "center", justifyContent: "center", gap: 2 },
        style,
      ]}
    >
      <Ionicons name="add" size={19} color="#FFFFFF" />
      <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "800" }}>{t("myDay.add")}</Text>
    </Reanimated.View>
  );
}

function StopRow({
  stop,
  number,
  upNext,
  pad,
  byId,
  nowMs,
  onToggleDone,
  onOpen,
  onClose,
}: {
  stop: MyDayStop;
  /** 1-based position among the walkable (non-emergency) stops; null = emergency. */
  number: number | null;
  upNext: boolean;
  pad: number;
  byId: Map<string, ParsedWorkOrder>;
  nowMs: number;
  onToggleDone: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const swipeRef = useRef<SwipeableMethods>(null);
  const primary = stop.workOrderIds.map((id) => byId.get(id)).find(Boolean);
  const emergency = stop.addedBy === "emergency";

  const content = (
    <>
      <Pressable
        onPress={onToggleDone}
        accessibilityRole="button"
        accessibilityLabel={t("myDay.markDone")}
        hitSlop={6}
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          marginTop: upNext ? 15 : 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: emergency ? RED : OLIVE,
        }}
      >
        <Text style={{ color: "#FFFFFF", fontSize: emergency ? 13 : 11, fontWeight: "800" }}>
          {emergency ? "!" : number}
        </Text>
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, paddingVertical: upNext ? 14 : 0 }}>
        {upNext ? (
          <Text style={{ fontSize: 9.5, fontWeight: "800", letterSpacing: 1.1, color: UP_NEXT, marginBottom: 4 }}>
            {t("myDay.upNext")}
          </Text>
        ) : null}
        <Text className="text-navy dark:text-white" style={{ fontSize: upNext ? 16 : 13.5, fontWeight: "800" }}>
          {stop.unitNumber}
          {stop.workOrderIds.length > 1 ? `  ·  ${t("myDay.tickets", { count: stop.workOrderIds.length })}` : ""}
        </Text>
        <Text
          className="text-navy dark:text-white/90"
          numberOfLines={2}
          style={{ fontSize: upNext ? 13 : 12.5, marginTop: 1, lineHeight: 17 }}
        >
          {primary?.title || t("myDay.workOrder")}
        </Text>
        {primary ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
            {emergency ? <ChipTag label={t("myDay.emergency")} color="#FFFFFF" bg={RED} /> : null}
            {emergency && primary.technicianDisplay === "Unassigned" ? (
              <ChipTag label={t("myDay.unassignedPinned")} color={MUTED} />
            ) : null}
            {primary.tags.slice(0, 2).map((t) => (
              <ChipTag key={t} label={t} color={tagTint(t)} icon={tagIconName(t)} />
            ))}
            {!emergency && primary.priority && primary.priority.toLowerCase() !== "normal" ? (
              <ChipTag label={primary.priority} color={workOrderStatusColor(primary.status)} />
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end", flexShrink: 0, paddingTop: upNext ? 14 : 0 }}>
        <Text className="text-slate dark:text-white/70" style={{ fontSize: 11.5, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {abbreviatedDate(primary?.reportedAt ?? null, nowMs)}
        </Text>
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 9.5, marginTop: 1 }}>
          #{primary?.number ?? "—"}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={13} color="rgba(9,27,84,0.28)" style={{ marginTop: upNext ? 18 : 4 }} />
    </>
  );

  const row = upNext ? (
    <Pressable onPress={onOpen} accessibilityRole="button" style={{ borderTopWidth: 1, borderTopColor: HAIRLINE }}>
      <LinearGradient
        colors={["rgba(37,99,180,0.10)", "rgba(37,99,180,0.02)", "rgba(37,99,180,0)"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingLeft: pad - 3.5, paddingRight: pad, borderLeftWidth: 3.5, borderLeftColor: UP_NEXT }}
      >
        {content}
      </LinearGradient>
    </Pressable>
  ) : (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: pad,
        paddingVertical: 11,
        borderTopWidth: 1,
        borderTopColor: HAIRLINE,
        backgroundColor: "rgba(252,250,244,0.001)",
      }}
    >
      {content}
    </Pressable>
  );

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={1.6}
      rightThreshold={56}
      overshootRight={false}
      renderRightActions={(_progress, translation) => <CloseAction translation={translation} />}
      onSwipeableOpen={(direction) => {
        if (direction === "right") {
          swipeRef.current?.close();
          onClose();
        }
      }}
    >
      {row}
    </ReanimatedSwipeable>
  );
}

/** A completed stop inside the expanded "Done today" recap. */
function DoneRow({
  stop,
  pad,
  byId,
  nowMs,
  onToggleDone,
  onOpen,
}: {
  stop: MyDayStop;
  pad: number;
  byId: Map<string, ParsedWorkOrder>;
  nowMs: number;
  onToggleDone: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const primary = stop.workOrderIds.map((id) => byId.get(id)).find(Boolean);
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: pad,
        paddingVertical: 11,
        borderTopWidth: 1,
        borderTopColor: HAIRLINE,
        backgroundColor: BAND,
      }}
    >
      <Pressable
        onPress={onToggleDone}
        accessibilityRole="button"
        accessibilityLabel={t("myDay.markNotDone")}
        hitSlop={6}
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          marginTop: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: GREEN,
        }}
      >
        <Ionicons name="checkmark" size={13} color="#FFFFFF" />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text className="text-muted" style={{ fontSize: 13.5, fontWeight: "800", textDecorationLine: "line-through" }}>
          {stop.unitNumber}
          {stop.workOrderIds.length > 1 ? `  ·  ${t("myDay.tickets", { count: stop.workOrderIds.length })}` : ""}
        </Text>
        <Text className="text-muted" numberOfLines={1} style={{ fontSize: 12.5, marginTop: 1, textDecorationLine: "line-through" }}>
          {primary?.title || t("myDay.workOrder")}
        </Text>
        <Text style={{ fontSize: 10, fontWeight: "700", color: GREEN, marginTop: 3 }}>
          {t("myDay.closedLine")} <Text style={{ color: MUTED, fontWeight: "600" }}>· {t("myDay.syncingToResman")}</Text>
        </Text>
      </View>
      <View style={{ alignItems: "flex-end", flexShrink: 0 }}>
        <Text className="text-slate dark:text-white/70" style={{ fontSize: 11.5, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {abbreviatedDate(primary?.reportedAt ?? null, nowMs)}
        </Text>
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 9.5, marginTop: 1 }}>
          #{primary?.number ?? "—"}
        </Text>
      </View>
    </Pressable>
  );
}

function ChipTag({ label, color, bg, icon }: { label: string; color: string; bg?: string; icon?: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3.5,
        paddingLeft: icon ? 6 : 8,
        paddingRight: 8,
        paddingVertical: 2.5,
        borderRadius: 999,
        backgroundColor: bg ?? `${color}14`,
        borderWidth: 1,
        borderColor: bg ?? `${color}42`,
      }}
    >
      {icon ? <MaterialCommunityIcons name={icon as never} size={11} color={color} /> : null}
      <Text style={{ fontSize: 9.5, fontWeight: "700", color }}>{label}</Text>
    </View>
  );
}

function QueueRow({
  wo,
  pad,
  nowMs,
  onOpen,
  onAdd,
}: {
  wo: ParsedWorkOrder;
  pad: number;
  nowMs: number;
  onOpen: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const swipeRef = useRef<SwipeableMethods>(null);
  const statusColor = workOrderStatusColor(wo.status);

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={1.6}
      leftThreshold={56}
      overshootLeft={false}
      renderLeftActions={(_progress, translation) => <AddAction translation={translation} />}
      onSwipeableOpen={(direction) => {
        if (direction === "left") {
          swipeRef.current?.close();
          onAdd();
        }
      }}
    >
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        style={{
          paddingHorizontal: pad,
          paddingVertical: 12,
          borderTopWidth: 1,
          borderTopColor: HAIRLINE,
          backgroundColor: "rgba(252,250,244,0.001)",
        }}
      >
        <Text className="text-navy dark:text-white" style={{ fontSize: 14, fontWeight: "600", lineHeight: 19 }}>
          {wo.title || t("myDay.untitledWorkOrder")}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 }}>
          <View style={{ paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: `${statusColor}1A` }}>
            <Text style={{ fontSize: 10.5, fontWeight: "700", color: statusColor }}>{wo.status}</Text>
          </View>
          <Text className="text-slate dark:text-white/70" style={{ fontSize: 11.5 }}>
            {wo.unitNumber}
          </Text>
          {urgentTrade(wo) ? (
            <MaterialCommunityIcons
              name="alert-circle-outline"
              size={13}
              color={TRADE_TINT[urgentTrade(wo)!]}
            />
          ) : null}
          <Text className="text-muted dark:text-white/50" style={{ fontSize: 11, marginLeft: "auto", fontVariant: ["tabular-nums"] }}>
            {abbreviatedDate(wo.reportedAt, nowMs)} · #{wo.number}
          </Text>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

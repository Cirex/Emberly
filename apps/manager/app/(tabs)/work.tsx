import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { BoardHeader, type BoardMetric, type BoardMode } from "@/components/ui/BoardHeader";
import { ClosedBoard } from "@/components/work/ClosedBoard";
import { MakeReadyBoard } from "@/components/work/MakeReadyBoard";
import { InsightsBoard } from "@/components/work/InsightsBoard";
import { OpenBoard } from "@/components/work/OpenBoard";
import { WorkOrderDetail } from "@/components/work/WorkOrderDetail";
import { capture } from "@/lib/analytics";
import {
  buildClosedBoard,
  buildMakeReadyBoard,
  buildOpenBoard,
  buildOpenUnitGroups,
  buildWorkData,
} from "@/lib/derived/work-boards";
import { buildWorkInsights } from "@/lib/derived/work-insights";
import { useConfig } from "@/lib/stores/config";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { MUTED, screenHPad } from "@/theme/tokens";

/**
 * Work — the manager's read-only maintenance oversight board: Open · Make
 * ready · Closed over the work-order mirror, all banding done by the shared
 * @emberly/core engine via lib/derived/work-boards.ts (pure + tested). No
 * close/edit anywhere — a row opens the read-only detail sheet, and the
 * maintenance app keeps the writes.
 */

type WorkModeKey = "open" | "makeReady" | "closed" | "insights";
const WORK_MODES: readonly WorkModeKey[] = ["open", "makeReady", "closed", "insights"];

function isWorkMode(value: string | undefined): value is WorkModeKey {
  return value !== undefined && (WORK_MODES as readonly string[]).includes(value);
}

export default function WorkScreen() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();

  const baseUrl = useConfig((s) => s.baseUrl);
  const token = useConfig((s) => s.token);
  const config = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);

  const workOrders = useWorkOrders((s) => s.workOrders);
  const loading = useWorkOrders((s) => s.loading);
  const error = useWorkOrders((s) => s.error);
  const refreshedAt = useWorkOrders((s) => s.refreshedAt);
  const allUnits = useUnits((s) => s.allUnits);

  const [mode, setMode] = useState<WorkModeKey>("open");
  const [headerH, setHeaderH] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep link from the Today board ("N turns in progress" → make-ready mode).
  // Applied on focus, once per distinct param value — a later manual mode
  // switch must not snap back on the next refocus.
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();
  const appliedModeParam = useRef<string | undefined>(undefined);

  // "Now" refreshes when the tab regains focus — calendar math stays
  // render-pure and still tracks the day across a long-lived session.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNowMs(Date.now());
      if (modeParam !== appliedModeParam.current) {
        appliedModeParam.current = modeParam;
        if (isWorkMode(modeParam)) setMode(modeParam);
      }
    }, [modeParam]),
  );

  // The sync tick owns refreshes; this only covers the cold cache on first
  // visit (idempotent — loadAll no-ops while a load is already in flight).
  useEffect(() => {
    if (workOrders.length === 0 && refreshedAt === 0 && token) {
      void useWorkOrders.getState().loadAll(config);
    }
  }, [workOrders.length, refreshedAt, token, config]);

  const data = useMemo(() => buildWorkData(workOrders, allUnits), [workOrders, allUnits]);
  const openBoard = useMemo(() => buildOpenBoard(data, nowMs), [data, nowMs]);
  const openGroups = useMemo(() => buildOpenUnitGroups(data, nowMs), [data, nowMs]);
  const makeReadyBoard = useMemo(() => buildMakeReadyBoard(data, nowMs), [data, nowMs]);
  const closedBoard = useMemo(() => buildClosedBoard(data, nowMs), [data, nowMs]);
  const insights = useMemo(() => buildWorkInsights(data, nowMs), [data, nowMs]);

  const selected = useMemo(
    () => (selectedId === null ? null : (data.parsed.find((wo) => wo.id === selectedId) ?? null)),
    [data, selectedId],
  );
  // The unit's other orders (newest first) — the detail page's history rail.
  const unitHistory = useMemo(() => {
    if (selected === null) return [];
    return data.parsed
      .filter((wo) => wo.id !== selected.id && wo.unitNumber !== "" && wo.unitNumber === selected.unitNumber)
      .sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0));
  }, [data, selected]);

  const onMode = (key: string) => {
    if (!isWorkMode(key)) return;
    setMode(key);
    capture("board_mode_switched", { mode: `work:${key}` });
  };

  const onOpenRow = (id: string) => {
    setSelectedId(id);
    capture("work_order_viewed", { mode });
  };

  const modes: BoardMode[] = [
    {
      key: "open",
      label: t("work.modes.open"),
      icon: "construct-outline",
      count: openBoard.openCount,
    },
    {
      key: "makeReady",
      label: t("work.modes.makeReady"),
      icon: "sparkles-outline",
      count: makeReadyBoard.rows.length,
    },
    {
      key: "closed",
      label: t("work.modes.closed"),
      icon: "checkmark-done-outline",
      count: closedBoard.rows.length,
    },
    {
      key: "insights",
      label: t("work.modes.insights"),
      icon: "stats-chart-outline",
    },
  ];

  const metricsByMode: Record<WorkModeKey, BoardMetric[]> = {
    open: [
      {
        value: String(openBoard.openCount),
        tint: "#2563B4",
        label: t("work.metrics.open"),
        caption: t("work.metrics.openCaption", { count: openBoard.callbackCount }),
      },
      {
        value: String(openBoard.emergencyCount),
        tint: "#D1382E",
        label: t("work.metrics.emergencies"),
        caption: t("work.metrics.emergenciesCaption"),
      },
      {
        value: t("work.days", { count: openBoard.avgAgeDays }),
        tint: "#B05E14",
        label: t("work.metrics.avgAge"),
        caption: t("work.metrics.avgAgeCaption"),
      },
    ],
    makeReady: [
      {
        value: String(makeReadyBoard.turnsInProgress),
        tint: "#7A6BC7",
        label: t("work.metrics.turnsInProgress"),
        caption: t("work.metrics.turnsInProgressCaption", { count: makeReadyBoard.blockedCount }),
      },
      {
        value: String(makeReadyBoard.readyUnits),
        tint: "#33A666",
        label: t("work.metrics.readyUnits"),
        caption: t("work.metrics.readyUnitsCaption"),
      },
      {
        value: String(makeReadyBoard.lateForMoveIn),
        tint: "#D1382E",
        label: t("work.metrics.lateForMoveIn"),
        caption: t("work.metrics.lateForMoveInCaption"),
      },
    ],
    closed: [
      {
        value: String(closedBoard.closedThisWeek),
        tint: "#33A666",
        label: t("work.metrics.closedThisWeek"),
        caption: t("work.metrics.closedThisWeekCaption"),
      },
      {
        value: String(closedBoard.closedThisMonth),
        tint: "#2563B4",
        label: t("work.metrics.closedThisMonth"),
        caption: t("work.metrics.closedThisMonthCaption"),
      },
      {
        value:
          closedBoard.avgDaysToClose === null
            ? "—"
            : t("work.days", { count: closedBoard.avgDaysToClose }),
        tint: "#7A6BC7",
        label: t("work.metrics.avgDaysToClose"),
        caption: t("work.metrics.avgDaysToCloseCaption"),
      },
    ],
    insights: [
      {
        value: String(insights.openNow),
        tint: "#2563B4",
        label: t("work.insights.scoreOpen"),
        caption: t("work.insights.scoreOpenCaption", {
          overdue: insights.overdue,
          emergency: insights.emergencies,
        }),
      },
      {
        value: String(insights.closed30),
        tint: "#33A666",
        label: t("work.insights.scoreClosed"),
        caption: t("work.insights.scoreClosedCaption", { prior: insights.closedPrior30 }),
      },
      {
        value: insights.medianCloseDays === null ? "—" : `${insights.medianCloseDays.toFixed(1)}d`,
        tint: "#B05E14",
        label: t("work.insights.scoreMedian"),
        caption: t("work.insights.scoreMedianCaption", { target: insights.targetDays }),
      },
      {
        value: `${insights.callbackRatePct.toFixed(1)}%`,
        tint: "#5B4BA8",
        label: t("work.insights.scoreCallback"),
        caption: t("work.insights.scoreCallbackCaption", { pairs: insights.callbackPairs }),
      },
      {
        value: insights.perTech.toFixed(1),
        tint: "#4C556F",
        label: t("work.insights.scorePerTech"),
        caption: t("work.insights.scorePerTechCaption"),
      },
    ],
  };

  // Cold cache only: with rows (or one successful sync) the boards render and
  // carry their own empty states.
  const cold = workOrders.length === 0 && refreshedAt === 0;
  const coldLoading = cold && (loading || !error);

  // Two-page flow: a selected order takes over the tab as a full page (the rail
  // stays put), and Back returns to the board. This replaces the old sheet.
  if (selected !== null) {
    return (
      <View style={{ flex: 1, paddingHorizontal: screenHPad(width) }}>
        <WorkOrderDetail
          order={selected}
          unitHistory={unitHistory}
          onBack={() => setSelectedId(null)}
          onOpenOrder={(id) => setSelectedId(id)}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <BoardHeader
        modes={modes}
        activeMode={mode}
        onMode={onMode}
        metrics={metricsByMode[mode]}
        onHeight={setHeaderH}
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: headerH + 16,
          paddingHorizontal: screenHPad(width),
          paddingBottom: 130,
        }}
      >
        {cold ? (
          coldLoading ? (
            <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center", gap: 10 }}>
              <ActivityIndicator />
              <Text style={{ fontSize: 12, color: MUTED }}>{t("work.loading")}</Text>
            </AppCardSurface>
          ) : (
            <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center", gap: 10 }}>
              <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>
                {t("work.loadError")}
              </Text>
              <Pressable
                onPress={() => void useWorkOrders.getState().loadAll(config)}
                accessibilityRole="button"
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 16,
                  paddingVertical: 7,
                  backgroundColor: "rgba(162,169,33,0.14)",
                  borderWidth: 1,
                  borderColor: "rgba(162,169,33,0.5)",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#767B24" }}>
                  {t("work.retry")}
                </Text>
              </Pressable>
            </AppCardSurface>
          )
        ) : mode === "open" ? (
          <OpenBoard groups={openGroups} onOpenRow={onOpenRow} />
        ) : mode === "makeReady" ? (
          <MakeReadyBoard
            board={makeReadyBoard}
            nowMs={nowMs}
            openGroups={openGroups}
            onOpenOrder={onOpenRow}
          />
        ) : mode === "insights" ? (
          <InsightsBoard insights={insights} />
        ) : (
          <ClosedBoard board={closedBoard} onOpenRow={onOpenRow} />
        )}
      </ScrollView>
    </View>
  );
}

import { useMemo, useState } from "react";
import { FlatList, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { capture } from "@/lib/analytics";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { ScoreCardGrid } from "@/components/work-orders/ScoreCardGrid";
import { AnalyticsOverlayHost } from "@/components/work-orders/analytics/OverlayHost";
import { HistoryList } from "@/components/work-orders/make-ready/HistoryList";
import { MakeReadyBoard } from "@/components/work-orders/make-ready/MakeReadyBoard";
import { MakeReadyModePill, type MakeReadyMode } from "@/components/work-orders/make-ready/MakeReadyModePill";
import { ScheduleList } from "@/components/work-orders/make-ready/ScheduleList";
import { TurnTrend } from "@/components/work-orders/make-ready/TurnTrend";
import { isFullyCompletedTurn, unitIsReady } from "@/lib/derived/make-ready";
import { useDerivedSnapshot } from "@/lib/hooks/use-derived-snapshot";
import { screenHPad } from "@/theme/tokens";
import { useShallow } from "zustand/react/shallow";
import { useWorkOrdersView } from "@/lib/stores/work-orders-view";
import { useNowMs } from "@/lib/hooks/use-now";

/**
 * Make Ready as its own tab: bare score grid under the mode dropdown pill
 * (Turns / Schedule / History), then the mode's body — the six-stage turn
 * board, the move-in day schedule, or the completed-turn history. The tab-bar
 * search applies; the snapshot is pinned to "makeReady" whatever the Work
 * Orders tab shows.
 */
export default function MakeReadyScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pad = screenHPad(width);

  // Only the make-ready slices — so search keystrokes, filter/overlay toggles,
  // and open/closed-board state don't re-render this board.
  const view = useWorkOrdersView(
    useShallow((s) => ({
      makeReadyQuickFilter: s.makeReadyQuickFilter,
      showCompletedTurns: s.showCompletedTurns,
      setActiveOverlay: s.setActiveOverlay,
      setMakeReadyQuickFilter: s.setMakeReadyQuickFilter,
      setShowCompletedTurns: s.setShowCompletedTurns,
    })),
  );
  const snapshot = useDerivedSnapshot("makeReady");
  // Stable within the minute — a fresh Date.now() every render invalidates
  // every memo downstream of it. See lib/hooks/use-now.
  const nowMs = useNowMs();

  const [mode, setMode] = useState<MakeReadyMode>("turns");

  // History reads the snapshot's full group list: "makeReady" membership is
  // status-blind (a completed make-ready stays until the sync drops it), so
  // completed turns are present regardless of the turns board's own filters.
  const completedTurns = useMemo(
    () => snapshot.makeReadyGroups.filter(isFullyCompletedTurn),
    [snapshot.makeReadyGroups],
  );
  // The schedule plans upcoming turns. A unit ResMan already flipped to
  // "Ready" is done in the system of record — stale tickets that never got
  // closed out must not keep it on the planning view, so unlike the turns
  // board there is no toggle to reveal these.
  const scheduleGroups = useMemo(
    () => snapshot.makeReadyGroups.filter((g) => !unitIsReady(g)),
    [snapshot.makeReadyGroups],
  );
  const scheduledCount = useMemo(
    () => scheduleGroups.filter((g) => g.moveInAt !== null).length,
    [scheduleGroups],
  );
  const pillCount =
    mode === "turns"
      ? snapshot.makeReadyGroups.length
      : mode === "schedule"
        ? scheduledCount
        : mode === "history"
          ? completedTurns.length
          // Trend counts the whole corpus it charts, not a filtered slice.
          : snapshot.makeReadyGroups.length;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={[]}
        renderItem={() => null}
        contentContainerStyle={{
          paddingTop: insets.top + 10,
          paddingBottom: insets.bottom + 110,
        }}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <View style={{ paddingHorizontal: pad, gap: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <MakeReadyModePill
                  mode={mode}
                  onMode={(m) => {
                    // Namespaced so the Work Orders board's mode strings stay distinct.
                    capture("board_mode_switched", { mode: `makeReady:${m}` });
                    setMode(m);
                  }}
                  count={pillCount}
                />
                <View style={{ flex: 1 }} />
                <AccountMenu />
              </View>
              <ScoreCardGrid cards={snapshot.scoreCards} onAction={(a) => view.setActiveOverlay(a)} />
            </View>
            {mode === "turns" ? (
              <MakeReadyBoard
                groups={snapshot.makeReadyGroups}
                quickCounts={snapshot.makeReadyQuickCounts}
                quickFilter={view.makeReadyQuickFilter}
                onQuickFilter={view.setMakeReadyQuickFilter}
                showCompleted={view.showCompletedTurns}
                onToggleShowCompleted={() => view.setShowCompletedTurns(!view.showCompletedTurns)}
                nowMs={nowMs}
                width={width}
                pad={pad}
              />
            ) : mode === "schedule" ? (
              <ScheduleList groups={scheduleGroups} nowMs={nowMs} pad={pad} />
            ) : mode === "history" ? (
              <HistoryList groups={completedTurns} nowMs={nowMs} pad={pad} />
            ) : (
              // The FULL group list, not completedTurns — the trend needs the
              // unfinished turns to have anything to show as "on the board".
              <TurnTrend groups={snapshot.makeReadyGroups} nowMs={nowMs} pad={pad} />
            )}
          </View>
        }
      />
      <AnalyticsOverlayHost snapshot={snapshot} />
    </View>
  );
}

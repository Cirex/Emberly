import { FlatList, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { ScoreCardGrid } from "@/components/work-orders/ScoreCardGrid";
import { AnalyticsOverlayHost } from "@/components/work-orders/analytics/OverlayHost";
import { MakeReadyBoard } from "@/components/work-orders/make-ready/MakeReadyBoard";
import { useDerivedSnapshot } from "@/lib/hooks/use-derived-snapshot";
import { useShallow } from "zustand/react/shallow";
import { useWorkOrdersView } from "@/lib/stores/work-orders-view";

/**
 * Make Ready as its own tab, Option 2 treatment: bare score grid, outline
 * quick-filter capsules, and the turn board flattened into full-bleed rows
 * (stage detail discloses per row). The tab-bar search applies; the snapshot
 * is pinned to "makeReady" whatever the Work Orders tab shows.
 */
export default function MakeReadyScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pad = width >= 1040 ? 34 : 20;

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
  const nowMs = Date.now();

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
              <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                <AccountMenu />
              </View>
              <ScoreCardGrid cards={snapshot.scoreCards} onAction={(a) => view.setActiveOverlay(a)} />
            </View>
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
          </View>
        }
      />
      <AnalyticsOverlayHost snapshot={snapshot} />
    </View>
  );
}

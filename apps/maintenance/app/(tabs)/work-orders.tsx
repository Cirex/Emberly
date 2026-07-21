import { useEffect, useMemo, useState } from "react";
import { FlatList, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";
import { FilterSheet } from "@/components/work-orders/FilterSheet";
import { GlassHeader } from "@/components/work-orders/GlassHeader";
import { AnalyticsOverlayHost } from "@/components/work-orders/analytics/OverlayHost";
import { ClosedRow, LoadingMoreFooter } from "@/components/work-orders/closed/ClosedRow";
import { HotSpots } from "@/components/work-orders/hot-spots/HotSpots";
import { OpenGroupCard } from "@/components/work-orders/open/OpenBoard";
import { ColumnHeader } from "@/components/work-orders/rows";
import { useDerivedSnapshot } from "@/lib/hooks/use-derived-snapshot";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { activeFilterCount, useWorkOrdersView } from "@/lib/stores/work-orders-view";

/** Incremental render page for long lists (smart scroll — no row caps). */
const RENDER_PAGE = 150;

/** 10pt of exposed backdrop between unit zones (approved D3 rev 2). */
function ZoneGap() {
  return <View style={{ height: 10 }} />;
}

/**
 * The Work Orders workspace host, approved D3 rev 2 (artifact 480091ba): a
 * liquid-glass header (mode title-menu pill, funnel + account, three-stat
 * strip) pinned over the list — content scrolls beneath it and blurs through.
 * Open mode renders each unit as a classification-tinted ZONE (rail + fading
 * wash) with slim ticket rows and the unit's tags collecting at the bottom.
 * Long lists still extend their render window as the scroll nears the bottom.
 */
export default function WorkOrdersScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pad = width >= 1040 ? 34 : 20;

  // Select only the slices this screen actually reads (directly + via
  // activeFilterCount) so unrelated store writes — notably the raw `search`
  // updated on every keystroke, plus filter-sheet/overlay toggles — don't
  // re-render this whole list host. Actions are stable refs; useShallow makes
  // the returned object stable when the selected values are unchanged.
  const view = useWorkOrdersView(
    useShallow((s) => ({
      debouncedSearch: s.debouncedSearch,
      displayMode: s.displayMode,
      sortOption: s.sortOption,
      expandedUnits: s.expandedUnits,
      selectedHotSpotUnit: s.selectedHotSpotUnit,
      openFilters: s.openFilters,
      closedFilters: s.closedFilters,
      signalFilter: s.signalFilter,
      setDisplayMode: s.setDisplayMode,
      setActiveOverlay: s.setActiveOverlay,
      setFilterSheetOpen: s.setFilterSheetOpen,
      setSelectedHotSpotUnit: s.setSelectedHotSpotUnit,
      toggleUnitExpanded: s.toggleUnitExpanded,
    })),
  );
  const filterCount = activeFilterCount(view);
  const snapshot = useDerivedSnapshot();
  const loading = useWorkOrders((s) => s.loading);
  const error = useWorkOrders((s) => s.error);
  const nowMs = Date.now();

  // The glass header's measured height; the list pads itself beneath it.
  const [headerH, setHeaderH] = useState(insets.top + 150);

  const [renderLimit, setRenderLimit] = useState(RENDER_PAGE);
  useEffect(() => {
    setRenderLimit(RENDER_PAGE);
  }, [view.displayMode, view.debouncedSearch, view.sortOption]);

  // "makeReady" moved to its own tab; a stale persisted mode from an earlier
  // build would land on a selector segment that no longer exists.
  useEffect(() => {
    if (view.displayMode === "makeReady") view.setDisplayMode("open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.displayMode]);

  // The pill count is the mode's visible-row count (mirrors the old card[0]).
  const pillCount = useMemo(() => {
    switch (view.displayMode) {
      case "closed":
        return snapshot.closedRows.length;
      case "hotSpots":
        return snapshot.hotSpotRows.length;
      default:
        return snapshot.openGroups.reduce((n, g) => n + g.workOrders.length, 0);
    }
  }, [view.displayMode, snapshot]);

  const facetMode = view.displayMode === "open" || view.displayMode === "closed";

  const header = (
    <GlassHeader
      mode={view.displayMode}
      onMode={view.setDisplayMode}
      count={pillCount}
      cards={snapshot.scoreCards}
      onAction={(a) => view.setActiveOverlay(a)}
      showFilters={facetMode}
      filterCount={filterCount}
      onOpenFilters={() => view.setFilterSheetOpen(true)}
      onOpenInsights={() => view.setActiveOverlay("closedInsights")}
      onHeight={setHeaderH}
    />
  );

  const statusLine =
    loading || error ? (
      <View style={{ paddingHorizontal: pad, paddingBottom: 8 }}>
        {loading ? (
          <Text className="text-muted" style={{ fontSize: 12, textAlign: "center" }}>
            Loading work orders…
          </Text>
        ) : null}
        {error ? <Text style={{ color: "#D1382E", fontSize: 12, textAlign: "center" }}>{error}</Text> : null}
      </View>
    ) : null;

  const emptyState = (
    <View style={{ alignItems: "center", paddingVertical: 48, gap: 6, paddingHorizontal: pad }}>
      <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
        Nothing here
      </Text>
      <Text className="text-muted dark:text-white/60" style={{ fontSize: 12.5, textAlign: "center" }}>
        {view.debouncedSearch || filterCount > 0
          ? "No work orders match the current search and filters."
          : "No work orders in this view yet."}
      </Text>
    </View>
  );

  const contentStyle = {
    paddingTop: headerH + 8,
    paddingBottom: insets.bottom + 110,
  } as const;

  // Modals ride along every mode.
  const modals = (
    <>
      <FilterSheet />
      <AnalyticsOverlayHost snapshot={snapshot} />
    </>
  );

  // ----- Open: zone-washed unit groups -----------------------------------
  if (view.displayMode === "open") {
    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={snapshot.openGroups.slice(0, renderLimit)}
          keyExtractor={(g) => g.unitNumber}
          contentContainerStyle={contentStyle}
          windowSize={7}
          ListHeaderComponent={statusLine}
          ListEmptyComponent={emptyState}
          ItemSeparatorComponent={ZoneGap}
          onEndReachedThreshold={0.6}
          onEndReached={() => setRenderLimit((l) => (l < snapshot.openGroups.length ? l + RENDER_PAGE : l))}
          ListFooterComponent={<LoadingMoreFooter visible={renderLimit < snapshot.openGroups.length} />}
          renderItem={({ item }) => (
            <OpenGroupCard
              group={item}
              // Rows are the default presentation; the persisted set now
              // tracks the units a tech has collapsed down to their summary.
              expanded={!view.expandedUnits.includes(item.unitNumber)}
              onToggle={() => view.toggleUnitExpanded(item.unitNumber)}
              nowMs={nowMs}
              pad={pad}
            />
          )}
        />
        {header}
        {modals}
      </View>
    );
  }

  // ----- Closed: full-bleed table with smart scroll ----------------------
  if (view.displayMode === "closed") {
    const rows = snapshot.closedRows;
    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={rows.slice(0, renderLimit)}
          keyExtractor={(r) => r.id}
          contentContainerStyle={contentStyle}
          ListHeaderComponent={
            <View>
              {statusLine}
              <ColumnHeader labels={["ID", "Status", "Unit", "Completed"]} />
            </View>
          }
          ListEmptyComponent={emptyState}
          onEndReachedThreshold={0.6}
          onEndReached={() => setRenderLimit((l) => (l < rows.length ? l + RENDER_PAGE : l))}
          ListFooterComponent={<LoadingMoreFooter visible={renderLimit < rows.length} />}
          renderItem={({ item }) => <ClosedRow row={item} />}
        />
        {header}
        {modals}
      </View>
    );
  }

  // ----- Hot Spots ------------------------------------------------------
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={[]}
        renderItem={() => null}
        contentContainerStyle={contentStyle}
        ListHeaderComponent={
          <View>
            {statusLine}
            <HotSpots
              rows={snapshot.hotSpotRows}
              selectedUnit={view.selectedHotSpotUnit}
              onSelectUnit={view.setSelectedHotSpotUnit}
              nowMs={nowMs}
              width={width}
              pad={pad}
            />
          </View>
        }
      />
      {header}
      {modals}
    </View>
  );
}

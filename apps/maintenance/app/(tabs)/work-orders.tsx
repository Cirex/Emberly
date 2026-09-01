import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, SectionList, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";
import { capture } from "@/lib/analytics";
import { FilterSheet } from "@/components/work-orders/FilterSheet";
import { GlassHeader } from "@/components/work-orders/GlassHeader";
import { AnalyticsOverlayHost } from "@/components/work-orders/analytics/OverlayHost";
import {
  ClosedBand,
  ClosedRow,
  LoadingMoreFooter,
} from "@/components/work-orders/closed/ClosedRow";
import {
  buildClosedSections,
  groupsApplyTo,
  singleClosedSection,
} from "@/lib/derived/closed-sections";
import type { ClosedWorkOrderRow } from "@/lib/derived/closed-rows";
import { useHotSpotsBoard, type HotSpotItem } from "@/components/work-orders/hot-spots/HotSpots";
import { OpenGroupCard } from "@/components/work-orders/open/OpenBoard";
import { PreventiveBoard } from "@/components/work-orders/preventive/PreventiveBoard";
import { buildPreventiveScoreCards, pmRoundTotals } from "@/lib/derived/pm-cards";
import { useDerivedSnapshot } from "@/lib/hooks/use-derived-snapshot";
import { isSignedIn, useConfig } from "@/lib/stores/config";
import { usePm } from "@/lib/stores/pm";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { activeFilterCount, useWorkOrdersView } from "@/lib/stores/work-orders-view";
import { useNowMs } from "@/lib/hooks/use-now";
import { TraceRender } from "@/lib/perf/render-trace";

/** Incremental render page for long lists (smart scroll — no row caps). */
const RENDER_PAGE = 150;

/** 10pt of exposed backdrop between unit zones (approved D3 rev 2). */
function ZoneGap() {
  return <View style={{ height: 10 }} />;
}

/** Module scope so the list's keyExtractor identity never changes. */
const keyOfGroup = (g: { unitNumber: string }) => g.unitNumber;
const keyOfClosedRow = (r: ClosedWorkOrderRow) => r.id;
const keyOfHotSpotItem = (i: HotSpotItem) => i.key;
/** One frozen empty array, so a non-list Hot Spots board never churns `data`. */
const NO_HOT_SPOT_ITEMS: HotSpotItem[] = [];

/**
 * The Work Orders workspace host, approved D3 rev 2 (artifact 480091ba): a
 * liquid-glass header (mode title-menu pill, funnel + account, three-stat
 * strip) pinned over the list — content scrolls beneath it and blurs through.
 * Open mode renders each unit as a classification-tinted ZONE (rail + fading
 * wash) with slim ticket rows and the unit's tags collecting at the bottom.
 * Long lists still extend their render window as the scroll nears the bottom.
 */
export default function WorkOrdersScreen() {
  const { t } = useTranslation();
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
  const pmTemplates = usePm((s) => s.templates);
  const pmLoading = usePm((s) => s.loading);
  const pmError = usePm((s) => s.error);
  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);
  const techName = useConfig((s) => s.admin?.displayName ?? "");
  // Stable within the minute — a fresh Date.now() every render invalidates
  // every memo downstream of it. See lib/hooks/use-now.
  const nowMs = useNowMs();

  // Entering Preventive pulls a fresh round (a no-op re-render when the server
  // has nothing new); the sync tick keeps it live afterwards.
  useEffect(() => {
    if (view.displayMode !== "preventive" || !isSignedIn({ token })) return;
    void usePm.getState().refresh({ baseUrl, token });
  }, [view.displayMode, token, baseUrl]);

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

  // The pill count is the mode's visible-row count (mirrors the old card[0]);
  // Preventive counts the round's still-pending unit tasks.
  const pillCount = useMemo(() => {
    switch (view.displayMode) {
      case "closed":
        return snapshot.closedRows.length;
      case "hotSpots":
        return snapshot.hotSpotRows.length;
      case "preventive":
        return pmRoundTotals(pmTemplates, nowMs).pending;
      default:
        return snapshot.openGroups.reduce((n, g) => n + g.workOrders.length, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.displayMode, snapshot, pmTemplates]);

  // Preventive's score strip comes from the PM store, not the snapshot.
  const cards = useMemo(
    () =>
      view.displayMode === "preventive"
        ? buildPreventiveScoreCards(pmTemplates, nowMs)
        : snapshot.scoreCards,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.displayMode, pmTemplates, snapshot.scoreCards],
  );

  const facetMode = view.displayMode === "open" || view.displayMode === "closed";

  // Stable handlers, so the memo on GlassHeader is a real cutoff instead of a
  // decoration: a fresh arrow function per render would fail the comparison
  // every time and the header would keep costing its measured 26-28ms.
  const setDisplayMode = view.setDisplayMode;
  const setActiveOverlay = view.setActiveOverlay;
  const setFilterSheetOpen = view.setFilterSheetOpen;
  const onMode = useCallback(
    (m: Parameters<typeof setDisplayMode>[0]) => {
      // The dropdown only, so the stale-mode migration effect above can't fire it.
      capture("board_mode_switched", { mode: m });
      setDisplayMode(m);
    },
    [setDisplayMode],
  );
  const onOpenFilters = useCallback(() => setFilterSheetOpen(true), [setFilterSheetOpen]);
  const onOpenInsights = useCallback(() => {
    capture("insights_viewed");
    setActiveOverlay("closedInsights");
  }, [setActiveOverlay]);

  const header = (
    <TraceRender id="wo:header">
      <GlassHeader
        mode={view.displayMode}
        onMode={onMode}
        count={pillCount}
        cards={cards}
        onAction={setActiveOverlay}
        showFilters={facetMode}
        filterCount={filterCount}
        onOpenFilters={onOpenFilters}
        onOpenInsights={onOpenInsights}
        onHeight={setHeaderH}
      />
    </TraceRender>
  );

  const statusLine =
    loading || error ? (
      <View style={{ paddingHorizontal: pad, paddingBottom: 8 }}>
        {loading ? (
          <Text className="text-muted" style={{ fontSize: 12, textAlign: "center" }}>
            Loading work orders…
          </Text>
        ) : null}
        {error ? (
          <Text style={{ color: "#D1382E", fontSize: 12, textAlign: "center" }}>{error}</Text>
        ) : null}
      </View>
    ) : null;

  // The launch parse covers OPEN work only, so for a beat after a cold start
  // the closed board genuinely has nothing to show. Saying "nothing here" then
  // would be a confident lie — it is still counting.
  const emptyState = !snapshot.complete ? (
    <View style={{ alignItems: "center", paddingVertical: 48, gap: 6, paddingHorizontal: pad }}>
      <Text
        className="text-muted dark:text-white/60"
        style={{ fontSize: 12.5, textAlign: "center" }}
      >
        {t("workOrders.stillLoading")}
      </Text>
    </View>
  ) : (
    <View style={{ alignItems: "center", paddingVertical: 48, gap: 6, paddingHorizontal: pad }}>
      <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
        Nothing here
      </Text>
      <Text
        className="text-muted dark:text-white/60"
        style={{ fontSize: 12.5, textAlign: "center" }}
      >
        {view.debouncedSearch || filterCount > 0
          ? "No work orders match the current search and filters."
          : "No work orders in this view yet."}
      </Text>
    </View>
  );

  // Memoized because a fresh style object is a changed prop on the list itself.
  const contentStyle = useMemo(
    () => ({ paddingTop: headerH + 8, paddingBottom: insets.bottom + 110 }),
    [headerH, insets.bottom],
  );

  // Modals ride along every mode.
  const modals = (
    <>
      <TraceRender id="wo:filter-sheet">
        <FilterSheet />
      </TraceRender>
      <TraceRender id="wo:overlays">
        <AnalyticsOverlayHost snapshot={snapshot} />
      </TraceRender>
    </>
  );

  // ----- Open: zone-washed unit groups -----------------------------------
  // Stable references for the closed list — see the note at its FlatList.
  //
  // Declared HERE, above every display-mode branch: those branches return early,
  // so a hook placed below one is called conditionally and React's hook order
  // breaks the moment a tech switches modes.
  const closedVisible = useMemo(
    () => snapshot.closedRows.slice(0, renderLimit),
    [snapshot.closedRows, renderLimit],
  );
  /**
   * Timeline bands, but ONLY when the ordering makes them true. Sorted by unit
   * or id, a "Today" header would sit above whichever rows happened to land
   * there — so a non-date sort renders as one unlabelled run instead.
   */
  const closedSections = useMemo(
    () =>
      groupsApplyTo(view.sortOption)
        ? buildClosedSections(closedVisible, nowMs)
        : singleClosedSection(closedVisible),
    [closedVisible, view.sortOption, nowMs],
  );
  const showBands = groupsApplyTo(view.sortOption);

  // ----- Open list props, all stable ------------------------------------
  // A new `data` array, a new `renderItem` or a new per-row `onToggle` closure
  // each render tells FlatList that everything changed, so every mounted card
  // re-renders — gradient, timeline rail and ticket rows included. That is the
  // work that made a tab change wait.
  const openVisible = useMemo(
    () => snapshot.openGroups.slice(0, renderLimit),
    [snapshot.openGroups, renderLimit],
  );
  const toggleUnit = view.toggleUnitExpanded;
  const expandedUnits = view.expandedUnits;
  const renderOpenGroup = useCallback(
    ({ item }: { item: (typeof openVisible)[number] }) => (
      <OpenGroupCard
        group={item}
        // Rows are the default presentation; the persisted set tracks the units
        // a tech has collapsed down to their summary.
        expanded={!expandedUnits.includes(item.unitNumber)}
        onToggle={toggleUnit}
        nowMs={nowMs}
        pad={pad}
      />
    ),
    [expandedUnits, toggleUnit, nowMs, pad],
  );
  // ----- Hot Spots: virtualized rows, not one giant header ---------------
  // Declared here with the other list props, above the display-mode branches,
  // for the same reason they are: those branches return early.
  const hotSpotsBoard = useHotSpotsBoard({
    enabled: view.displayMode === "hotSpots",
    rows: snapshot.hotSpotRows,
    selectedUnit: view.selectedHotSpotUnit,
    onSelectUnit: view.setSelectedHotSpotUnit,
    nowMs,
    width,
    pad,
  });
  // Pulled out so the FlatList's renderItem stays stable: the board object
  // itself is a fresh literal each render, but the function inside it is
  // memoized, so depending on the function rather than the board is a real
  // cutoff instead of a decoration.
  const boardRenderItem = hotSpotsBoard.kind === "rows" ? hotSpotsBoard.renderItem : null;
  const renderHotSpotItem = useCallback(
    ({ item }: { item: HotSpotItem }) => <>{boardRenderItem?.(item) ?? null}</>,
    [boardRenderItem],
  );

  const renderClosedRow = useCallback(
    ({ item, section }: { item: ClosedWorkOrderRow; section: { key: string } }) => (
      <ClosedRow row={item} today={section.key === "today"} />
    ),
    [],
  );
  const renderClosedBand = useCallback(
    ({ section }: { section: { labelKey: string; count: number } }) =>
      showBands ? (
        <ClosedBand label={t(`workOrders.closed.band.${section.labelKey}`)} count={section.count} />
      ) : null,
    [showBands, t],
  );

  if (view.displayMode === "open") {
    return (
      <View style={{ flex: 1 }}>
        <FlatList
          // Every mode branch returns the same <View><FlatList/>… shape, and
          // React reconciles by type and position — it knows nothing about
          // which `return` produced them. Without a key the three FlatList
          // modes are ONE VirtualizedList instance that keeps its contentOffset
          // and its ListMetricsAggregator across a mode switch, so Open opens
          // at the scroll position of a board it has never rendered.
          key={view.displayMode}
          data={openVisible}
          keyExtractor={keyOfGroup}
          contentContainerStyle={contentStyle}
          windowSize={7}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
          ListHeaderComponent={statusLine}
          ListEmptyComponent={emptyState}
          ItemSeparatorComponent={ZoneGap}
          onEndReachedThreshold={0.6}
          onEndReached={() =>
            setRenderLimit((l) => (l < snapshot.openGroups.length ? l + RENDER_PAGE : l))
          }
          ListFooterComponent={
            <LoadingMoreFooter visible={renderLimit < snapshot.openGroups.length} />
          }
          renderItem={renderOpenGroup}
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
        <SectionList
          key={view.displayMode}
          // `closedSections`/`renderClosedRow` are memoized above. Building
          // either inline would hand the list a new reference on every parent
          // render, re-rendering every mounted row — which on a board of
          // thousands is a visible stall that blocks even a tab change.
          sections={closedSections}
          keyExtractor={keyOfClosedRow}
          renderSectionHeader={renderClosedBand}
          stickySectionHeadersEnabled={showBands}
          contentContainerStyle={contentStyle}
          // The open list has carried these since it was built; the closed list
          // never got them, which is why Closed felt heavier despite holding
          // simpler rows. RENDER_PAGE is 150, so without a bounded first batch
          // FlatList mounts far more rows than a screen can show before it
          // paints anything.
          windowSize={7}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
          // The column header is gone with the table: rows now lead with the
          // closing technician and carry their own labelled chips, so a
          // "ID · Status · Unit · Completed" ruler describes nothing on screen.
          ListHeaderComponent={<View>{statusLine}</View>}
          ListEmptyComponent={emptyState}
          onEndReachedThreshold={0.6}
          onEndReached={() => setRenderLimit((l) => (l < rows.length ? l + RENDER_PAGE : l))}
          ListFooterComponent={<LoadingMoreFooter visible={renderLimit < rows.length} />}
          renderItem={renderClosedRow}
        />
        {header}
        {modals}
      </View>
    );
  }

  // ----- Preventive: Emberly PM rounds (PM store, not the snapshot) -------
  if (view.displayMode === "preventive") {
    return (
      <View style={{ flex: 1 }}>
        <FlatList
          key={view.displayMode}
          data={[]}
          renderItem={() => null}
          contentContainerStyle={contentStyle}
          ListHeaderComponent={
            <View>
              {pmLoading || pmError ? (
                <View style={{ paddingHorizontal: pad, paddingBottom: 8, gap: 4 }}>
                  {pmLoading ? (
                    <Text className="text-muted" style={{ fontSize: 12, textAlign: "center" }}>
                      {t("preventive.loading")}
                    </Text>
                  ) : null}
                  {pmError ? (
                    <Text style={{ color: "#D1382E", fontSize: 12, textAlign: "center" }}>
                      {pmError}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              <PreventiveBoard
                templates={pmTemplates}
                nowMs={nowMs}
                pad={pad}
                onSetStatus={(taskId, status) =>
                  void usePm.getState().checkOff(taskId, status, { baseUrl, token }, techName)
                }
              />
            </View>
          }
        />
        {header}
        {modals}
      </View>
    );
  }

  // ----- Hot Spots ------------------------------------------------------
  // The ranked rows are the list's DATA now, not one un-virtualized slab
  // handed over as ListHeaderComponent. That slab was ~200 uncapped rows at
  // ~27 native views each, mounted as a single child of the scroll content
  // view — and RN's legacy clipping walk then recursed all of it on the main
  // thread on every commit and every 44pt of scroll. It is the confirmed cause
  // of an 8.1-8.9s production App Hang (EMBERLY-MAINTENANCE-3, whose stack is
  // that recursion bottoming out in convertRect:toView:). See HotSpotList.
  //
  // Only the phone's ranked view virtualizes. The empty state, the phone
  // detail pane and the tablet split are small and ride in the header, where
  // the tablet's inner list also avoids nesting one VirtualizedList in another.
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        key={view.displayMode}
        data={hotSpotsBoard.kind === "rows" ? hotSpotsBoard.items : NO_HOT_SPOT_ITEMS}
        keyExtractor={keyOfHotSpotItem}
        renderItem={renderHotSpotItem}
        contentContainerStyle={contentStyle}
        windowSize={7}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews
        ListHeaderComponent={
          <View>
            {statusLine}
            {hotSpotsBoard.kind === "rows" ? hotSpotsBoard.header : hotSpotsBoard.node}
          </View>
        }
      />
      {header}
      {modals}
    </View>
  );
}

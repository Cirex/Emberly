import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useColorScheme } from "nativewind";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState, useRef } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { capture } from "@/lib/analytics";
import {
  EMPTY_SEARCH_SESSION,
  advanceSearchSession,
  type SearchSessionState,
} from "@/lib/search-session";
import { TenantDetailCard, TenantDetailEmptyCard } from "@/components/tenants/TenantDetailCard";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { AppFilterChip } from "@/components/ui/AppFilterChip";
import { AppMetricCard } from "@/components/ui/AppMetricCard";
import { AppScreenHeader } from "@/components/ui/AppScreenHeader";
import { AppSearchField } from "@/components/ui/AppSearchField";
import { AppStatusBadge } from "@emberly/ui";
import type { ResmanUnit } from "@/lib/api/units";
import { useTenantDetails } from "@/lib/stores/tenant-details";
import { useConfig } from "@/lib/stores/config";
import { useMapJump } from "@emberly/ui";
import { useMetrics } from "@/lib/stores/metrics";
import { useTags, type UnitTag } from "@/lib/stores/tags";
import { computeVisibleUnits, type UnitFilter, useUnits } from "@/lib/stores/units";
import {
  lastSyncedLabel,
  unitClassification,
  unitInitials,
  unitLine,
  unitPrimaryName,
  unitStatus,
} from "@/lib/unit-display";

const EMPTY_TAGS: UnitTag[] = [];
/** Spacing between rows in the virtualized list — was the list's `gap: 9`. */
const ROW_GAP = 9;

// `key` must stay as ResMan spells the status it filters on; only the label is
// ours. Notice/Eviction select on lease_status rather than occupancy — ResMan
// files both under the single occupancy "Notice", so that column can't tell a
// tenant who gave notice from one being evicted, and these are 4 units versus
// 56. "No Guests" is first-party: units where an admin disabled guest visits.
const FILTERS: { key: UnitFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "Occupied", label: "Occupied" },
  { key: "Vacant", label: "Vacant" },
  { key: "Notice to Vacate", label: "Notice to Vacate" },
  { key: "Under Eviction", label: "Eviction" },
  { key: "No Guests", label: "No Guests" },
];

/**
 * Below this *content* width (i.e. after horizontal padding) the detail becomes a
 * sheet instead of a column — matching TenantsDashboardView's `isCompact`.
 */
const COMPACT_MAX_CONTENT_WIDTH = 900;

/** Compact shared-tag chips for a list row: up to two, then a "+N" that
 *  expands the rest inline (tap does not select the row). */
function RowTagChips({
  tags,
  expanded,
  onExpand,
}: {
  tags: UnitTag[];
  expanded: boolean;
  onExpand: () => void;
}) {
  if (tags.length === 0) return null;
  const shown = expanded ? tags : tags.slice(0, 2);
  const hidden = tags.length - shown.length;
  return (
    <View className="flex-row items-center" style={{ gap: 5, flexWrap: "wrap", marginTop: 6 }}>
      {shown.map((t) => (
        <View
          key={t.id}
          className="flex-row items-center"
          style={{
            gap: 4,
            paddingVertical: 2,
            paddingHorizontal: 7,
            borderRadius: 999,
            backgroundColor: `${t.colorHex}1F`,
            borderWidth: 0.5,
            borderColor: `${t.colorHex}55`,
          }}
        >
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.colorHex }} />
          <Text style={{ fontSize: 10.5, fontWeight: "600", color: t.colorHex }}>{t.label}</Text>
        </View>
      ))}
      {hidden > 0 ? (
        <Pressable
          onPress={onExpand}
          hitSlop={8}
          style={{
            paddingVertical: 2,
            paddingHorizontal: 8,
            borderRadius: 999,
            backgroundColor: "rgba(9,27,84,0.07)",
          }}
        >
          <Text
            className="text-slate dark:text-white/60"
            style={{ fontSize: 10.5, fontWeight: "700" }}
          >
            +{hidden}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One tenant row. Memoized so a selection change (or a background unit refresh)
 * only re-renders the rows whose props actually changed — not all 878. The
 * callbacks it takes are stable, so `memo` can do its job.
 */
const TenantRow = memo(function TenantRow({
  unit,
  isSelected,
  onSelect,
  tags,
  expanded,
  onExpand,
}: {
  unit: ResmanUnit;
  isSelected: boolean;
  onSelect: (id: string) => void;
  tags: UnitTag[];
  expanded: boolean;
  onExpand: (unitNumber: string) => void;
}) {
  const status = unitStatus(unit);
  return (
    <Pressable
      onPress={() => onSelect(unit.resman_unit_id)}
      accessibilityRole="button"
      accessibilityState={isSelected ? { selected: true } : {}}
    >
      <AppCardSurface kind="row">
        <View
          className="flex-row items-center"
          style={{
            padding: 14,
            gap: 14,
            // Selection reads as a ring rather than a fill, so the status badge
            // keeps its meaning.
            borderRadius: 18,
            borderWidth: isSelected ? 2 : 0,
            borderColor: isSelected ? "#A2A921" : "transparent",
          }}
        >
          <View
            className="items-center justify-center rounded-full"
            style={{ width: 58, height: 58, backgroundColor: "#E9E6D1" }}
          >
            <Text style={{ color: "#848F0D", fontSize: 20, fontWeight: "700" }}>
              {unitInitials(unit)}
            </Text>
          </View>
          <View className="flex-1">
            <Text
              className="text-navy dark:text-white"
              style={{ fontSize: 17, fontWeight: "700" }}
              numberOfLines={1}
            >
              {unitPrimaryName(unit)}
            </Text>
            <Text
              className="text-slate dark:text-white/70"
              style={{ fontSize: 14, fontWeight: "500" }}
              numberOfLines={1}
            >
              {unitLine(unit)}
            </Text>
            {unitClassification(unit) ? (
              <Text className="text-muted" style={{ fontSize: 13, fontWeight: "500" }}>
                {unitClassification(unit)}
              </Text>
            ) : null}
            <RowTagChips tags={tags} expanded={expanded} onExpand={() => onExpand(unit.number)} />
          </View>
          <AppStatusBadge label={status.label} tint={status.tint} />
        </View>
      </AppCardSurface>
    </Pressable>
  );
});

export default function TenantsScreen() {
  const router = useRouter();
  const config = useConfig();
  // Narrow slices, not the whole store: the units store re-writes on every 60s
  // sync tick, and subscribing to the whole thing re-rendered the screen (and
  // re-filtered 878 units) each time. Each selector re-renders only on its own
  // change.
  const filter = useUnits((s) => s.filter);
  const search = useUnits((s) => s.search);
  const setFilter = useUnits((s) => s.setFilter);
  const setSearch = useUnits((s) => s.setSearch);
  const allUnits = useUnits((s) => s.allUnits);
  const pageUnits = useUnits((s) => s.units);
  const bannedUnits = useUnits((s) => s.bannedUnits);
  const loadingAll = useUnits((s) => s.loadingAll);
  const unitsError = useUnits((s) => s.error);
  const loadUnits = useUnits((s) => s.load);
  const loadAllUnits = useUnits((s) => s.loadAll);
  // The whole property's detail panes, cached on disk and refreshed on sync.
  const detailsByUnit = useTenantDetails((s) => s.byUnit);
  const detailsLoading = useTenantDetails((s) => s.loading);
  const detailsError = useTenantDetails((s) => s.error);
  const loadAllDetails = useTenantDetails((s) => s.loadAll);
  const refreshUnitDetail = useTenantDetails((s) => s.refreshUnit);

  // Property-wide headline counts for the metric cards (cached + 60s refresh).
  const entriesToday = useMetrics((s) => s.entriesToday);
  const entriesGuestsToday = useMetrics((s) => s.entriesGuestsToday);
  const vehicleCount = useMetrics((s) => s.vehicleCount);

  // One event per search SESSION. A session ends when the box is cleared OR
  // when it sits untouched past the idle window — see lib/search-session.
  // Without the idle rule a guard who types over the previous unit all shift
  // registered a single event for the whole shift.
  const session = useRef<SearchSessionState>(EMPTY_SEARCH_SESSION);
  useEffect(() => {
    const step = advanceSearchSession(session.current, search, Date.now());
    session.current = step.next;
    // `after_idle` splits the two reset paths so the window can be tuned on
    // evidence rather than guesswork.
    if (step.started) capture("unit_lookup_performed", { after_idle: step.afterIdle });
  }, [search]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const hPad = width >= 1040 ? 34 : 24;

  // Column geometry, ported from TenantsDashboardView.tenantColumns.
  const contentWidth = Math.max(width - hPad * 2, 0);
  const isCompact = contentWidth < COMPACT_MAX_CONTENT_WIDTH;
  const detailWidth = Math.min(Math.max(contentWidth * 0.36, 390), 430);

  const tagsByUnit = useTags((s) => s.byUnit);
  const tagsHydrated = useTags((s) => s.hydrated);
  const hydrateTags = useTags((s) => s.hydrate);
  const tagsFor = useCallback(
    (unitNumber: string) => tagsByUnit[unitNumber] ?? EMPTY_TAGS,
    [tagsByUnit],
  );
  // Rows show at most two tag chips; tapping "+N" expands that row's chips.
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const expandTags = useCallback(
    (n: string) => setExpandedTags((prev) => new Set(prev).add(n)),
    [],
  );

  // The visible rows, memoized: recompute only when a real input moves, not on
  // every render. Filter switches are now pure client-side work over the cached
  // set — no network round-trip, so the list turns over instantly.
  const rows = useMemo(
    () => computeVisibleUnits({ units: pageUnits, allUnits, search, filter, bannedUnits }),
    [pageUnits, allUnits, search, filter, bannedUnits],
  );
  // The list is the expensive part of a chip switch (a 5-row view turning into
  // 878). Deferring only the FlatList's data lets the chip and the count repaint
  // on the tap, with the row turnover landing in the next, interruptible pass —
  // so the press feels immediate instead of blocking on the list.
  const listRows = useDeferredValue(rows);
  const syncedLabel = useMemo(
    () => lastSyncedLabel(allUnits.length > 0 ? allUnits : pageUnits),
    [allUnits, pageUnits],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The pane reads straight from the cached bulk snapshot, so a tap paints the
  // vehicles with it instead of behind a spinner. `loading` is true only before
  // the very first bulk load lands — after that there is always something to
  // show, and refreshes fold in silently.
  const detail = selectedId ? (detailsByUnit[selectedId] ?? null) : null;
  const detailLoading = detail === null && detailsLoading;
  const detailError = detail === null ? detailsError : "";
  // Measured rather than assumed: the header chrome and the metrics both float
  // over the list, so the list needs to know exactly how much room to leave
  // before its first row.
  const [metricsHeight, setMetricsHeight] = useState(0);
  const [chromeHeight, setChromeHeight] = useState(0);
  const darkScheme = useColorScheme().colorScheme === "dark";

  useEffect(() => {
    if (!config.hydrated) return;
    // Filtering is entirely client-side over the cached full set, so a filter
    // switch no longer refetches — this runs once per session. The fast first
    // page paints immediately; loadAll fills in the rest for real filtering and
    // search. Both are skipped when the persisted cache already has the data.
    if (allUnits.length === 0) {
      void loadUnits(config);
      void loadAllUnits(config);
    }
    // Every unit's detail pane in one request, so tapping down the list never
    // waits on a per-unit round trip. Cached to disk, so this is a no-op
    // refresh on a warm start.
    void loadAllDetails(config);
    if (!tagsHydrated) void hydrateTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.hydrated]);

  const selected = useMemo(
    () => rows.find((u) => u.resman_unit_id === selectedId) ?? null,
    [rows, selectedId],
  );

  const select = useCallback(
    (unitId: string) => {
      setSelectedId(unitId);
      // No fetch on the tap itself: the pane reads the cache below. Only a unit
      // the bulk load hasn't reached still needs one, and either way we
      // re-read that unit in the background so the pane self-corrects.
      void refreshUnitDetail(unitId, config);
    },
    [refreshUnitDetail, config],
  );

  // One pass, not two. This used to be a pair of effects — clear a selection the
  // filter dropped, re-render, then auto-select the new first row — so every chip
  // tap re-rendered the whole list twice mid-turnover. Resolving both in a single
  // effect keeps a chip switch to one render.
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId) setSelectedId(null);
      return;
    }
    if (selectedId && rows.some((u) => u.resman_unit_id === selectedId)) return;
    // In the compact layout the detail is a sheet, so auto-selecting would throw
    // it over the list before the guard asked for anything — just drop it.
    if (isCompact) {
      if (selectedId) setSelectedId(null);
      return;
    }
    select(rows[0].resman_unit_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedId, isCompact, select]);

  const renderItem = useCallback(
    ({ item }: { item: ResmanUnit }) => (
      <TenantRow
        unit={item}
        isSelected={item.resman_unit_id === selectedId}
        onSelect={select}
        tags={tagsFor(item.number)}
        expanded={expandedTags.has(item.number)}
        onExpand={expandTags}
      />
    ),
    [selectedId, select, tagsFor, expandedTags, expandTags],
  );
  const keyExtractor = useCallback((u: ResmanUnit) => u.resman_unit_id, []);
  const ItemSeparator = useCallback(() => <View style={{ height: ROW_GAP }} />, []);

  const openSettings = () => router.push("/settings");

  // "Showing" reflects the active view and updates instantly with the filter —
  // no more divergence from a lagging server count. The caption names what's
  // narrowing it; on the unfiltered view it carries the sync time instead.
  const showingCaption = search.trim()
    ? `matching “${search.trim()}”`
    : filter !== "all"
      ? (FILTERS.find((f) => f.key === filter)?.label ?? "filtered")
      : syncedLabel;

  const detailCard = selected ? (
    <TenantDetailCard
      unit={selected}
      detail={detail}
      loading={detailLoading}
      error={detailError}
      config={config}
      onViewOnMap={() => {
        setSelectedId(null);
        useMapJump.getState().request(selected.number);
        router.push("/property-map");
      }}
    />
  ) : (
    <TenantDetailEmptyCard />
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, flexDirection: "row", paddingHorizontal: hPad, gap: 18 }}>
        {/* The only scrolling region — tenantsListColumn, VStack(spacing: 13).
            Full height: rows run up under the floating header chrome and fade
            out in the scrim, the same treatment as the property map. */}
        <View style={{ flex: 1 }}>
          <FlatList
            style={{ flex: 1 }}
            data={listRows}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            ItemSeparatorComponent={ItemSeparator}
            contentContainerStyle={{
              // Clear the floating chrome + metrics, then keep the list's rhythm.
              paddingTop: chromeHeight + metricsHeight + 13,
              paddingBottom: insets.bottom + 96,
            }}
            showsVerticalScrollIndicator={false}
            // Virtualization: only the visible window mounts, so switching from a
            // 5-unit view to the 878-unit "All" no longer builds hundreds of card
            // surfaces on the JS thread.
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={11}
            removeClippedSubviews
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={loadingAll}
                onRefresh={() => {
                  void loadAllUnits(config);
                  void useMetrics.getState().refresh(config);
                }}
                tintColor="#70788F"
                progressViewOffset={chromeHeight + metricsHeight}
              />
            }
            ListEmptyComponent={
              unitsError ? (
                <AppCardSurface kind="row">
                  <View style={{ padding: 16, gap: 6 }}>
                    <Text
                      className="text-status-blocked"
                      style={{ fontSize: 15, fontWeight: "700" }}
                    >
                      Couldn&apos;t load units
                    </Text>
                    <Text className="text-muted" style={{ fontSize: 14 }}>
                      {unitsError}
                    </Text>
                  </View>
                </AppCardSurface>
              ) : loadingAll ? null : (
                <Text
                  className="text-muted"
                  style={{ fontSize: 14, paddingHorizontal: 4, paddingTop: 8 }}
                >
                  {allUnits.length === 0 && pageUnits.length === 0
                    ? "No units synced yet."
                    : "No units match this view."}
                </Text>
              )
            }
          />

          {/* Floats over the list — glass, so rows blur through as they pass
              beneath rather than vanishing behind an opaque slab. box-none so
              only the cards themselves swallow touches. Sits just below the
              floating header chrome. */}
          <View
            pointerEvents="box-none"
            onLayout={(e) => setMetricsHeight(e.nativeEvent.layout.height)}
            style={{ position: "absolute", top: chromeHeight, left: 0, right: 0 }}
          >
            <View className="flex-row" style={{ gap: 12 }}>
              <View className="flex-1">
                <AppMetricCard
                  icon="funnel"
                  title="Showing"
                  value={rows.length.toLocaleString()}
                  caption={showingCaption}
                />
              </View>
              <View className="flex-1">
                <AppMetricCard
                  icon="log-in-outline"
                  title="Entries Today"
                  value={entriesToday.toLocaleString()}
                  caption={
                    entriesToday === 0
                      ? "none yet today"
                      : `${entriesGuestsToday.toLocaleString()} guest${entriesGuestsToday === 1 ? "" : "s"}`
                  }
                />
              </View>
              <View className="flex-1">
                <AppMetricCard
                  icon="car-outline"
                  title="Vehicles"
                  value={vehicleCount.toLocaleString()}
                  caption="on file"
                />
              </View>
            </View>
          </View>
        </View>

        {/* Pinned: stays on screen while the list scrolls, and only scrolls
            internally if the card outgrows the viewport. Starts below the
            floating chrome — running the pinned pane under the header would
            just hide its top rows forever. */}
        {isCompact ? null : (
          <View style={{ width: detailWidth, paddingTop: chromeHeight }}>
            <ScrollView
              contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
              showsVerticalScrollIndicator={false}
            >
              {detailCard}
            </ScrollView>
          </View>
        )}
      </View>

      {/* Floating header chrome — brand, search, and filters ride over the
          list instead of boxing it in, so rows scroll beneath everything. The
          scrim fades them out against the backdrop before they reach the
          title, exactly like the map's edge scrims. */}
      <LinearGradient
        pointerEvents="none"
        colors={
          darkScheme
            ? ["#14181F", "rgba(20,24,31,0.94)", "rgba(20,24,31,0)"]
            : ["#FCF8F0", "rgba(252,248,240,0.94)", "rgba(252,248,240,0)"]
        }
        locations={[0, 0.62, 1]}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: chromeHeight + 40 }}
      />
      <View
        pointerEvents="box-none"
        onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          paddingTop: insets.top + 26,
          paddingHorizontal: hPad,
          paddingBottom: 18,
        }}
      >
        <AppScreenHeader
          title="Tenants"
          subtitle="View and manage residents with secure building access."
          trailing={
            <>
              <AppSearchField
                value={search}
                onChangeText={setSearch}
                placeholder="Search tenants"
                width={240}
              />
              <Pressable
                onPress={openSettings}
                accessibilityLabel="Device setup"
                className="bg-white dark:bg-white/10"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: "rgba(9,27,84,0.12)",
                }}
              >
                <Ionicons name="settings-outline" size={20} color="#4C556F" />
              </Pressable>
            </>
          }
        />

        {/* Above the columns, not inside the list: keeping the chips in the left
            column pushed its first card ~a chip-row lower than the detail card,
            so the two sides read as misaligned. Out here both columns start with
            a card on the same line, and the filters stay put while the list
            scrolls. */}
        <View
          pointerEvents="box-none"
          className="flex-row flex-wrap"
          style={{ gap: 8, marginTop: 18 }}
        >
          {FILTERS.map((f) => (
            <AppFilterChip
              key={f.key}
              label={f.label}
              selected={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </View>
      </View>

      {isCompact ? (
        <Modal
          visible={!!selected}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setSelectedId(null)}
        >
          <View className="flex-1 bg-paper-top dark:bg-night-top">
            <View className="flex-row items-center justify-between" style={{ padding: 18 }}>
              <Text
                className="text-navy dark:text-white"
                style={{ fontSize: 20, fontWeight: "700" }}
              >
                Tenant
              </Text>
              <Pressable onPress={() => setSelectedId(null)} hitSlop={10}>
                <Text
                  className="text-slate dark:text-white/70"
                  style={{ fontSize: 16, fontWeight: "600" }}
                >
                  Done
                </Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 32 }}>
              {detailCard}
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

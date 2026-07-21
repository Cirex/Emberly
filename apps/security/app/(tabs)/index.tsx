import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useColorScheme } from "nativewind";
import { useCallback, useEffect, useState, useRef } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { capture } from "@/lib/analytics";
import { TenantDetailCard, TenantDetailEmptyCard } from "@/components/tenants/TenantDetailCard";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { AppFilterChip } from "@/components/ui/AppFilterChip";
import { AppMetricCard } from "@/components/ui/AppMetricCard";
import { AppScreenHeader } from "@/components/ui/AppScreenHeader";
import { AppSearchField } from "@/components/ui/AppSearchField";
import { AppStatusBadge } from "@emberly/ui";
import { getTenantDetail, type TenantDetail } from "@/lib/api/tenant-detail";
import { useConfig } from "@/lib/stores/config";
import { useMapJump } from "@emberly/ui";
import { useTags, type UnitTag } from "@/lib/stores/tags";
import { type UnitFilter, useUnits } from "@/lib/stores/units";
import {
  lastSyncedLabel,
  unitClassification,
  unitInitials,
  unitLine,
  unitPrimaryName,
  unitStatus,
} from "@/lib/unit-display";

// `key` must stay as ResMan spells the status it filters on; only the label is
// ours. The last two select on lease_status rather than occupancy — ResMan files
// both under the single occupancy "Notice", so that column can't tell a tenant
// who gave notice from one being evicted, and these are 4 units versus 56.
const FILTERS: { key: UnitFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "Occupied", label: "Occupied" },
  { key: "Vacant", label: "Vacant" },
  { key: "Notice to Vacate", label: "Notice to Vacate" },
  { key: "Under Eviction", label: "Eviction" },
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
          style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: "rgba(9,27,84,0.07)" }}
        >
          <Text className="text-slate dark:text-white/60" style={{ fontSize: 10.5, fontWeight: "700" }}>
            +{hidden}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function TenantsScreen() {
  const router = useRouter();
  const config = useConfig();
  const units = useUnits();
  // One event per search session: fires when the box goes empty → non-empty.
  const hadQuery = useRef(false);
  useEffect(() => {
    const has = units.search.trim().length > 0;
    if (has && !hadQuery.current) capture("unit_lookup_performed");
    hadQuery.current = has;
  }, [units.search]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const hPad = width >= 1040 ? 34 : 24;

  // Column geometry, ported from TenantsDashboardView.tenantColumns.
  const contentWidth = Math.max(width - hPad * 2, 0);
  const isCompact = contentWidth < COMPACT_MAX_CONTENT_WIDTH;
  const detailWidth = Math.min(Math.max(contentWidth * 0.36, 390), 430);

  const tagStore = useTags();
  // Rows show at most two tag chips; tapping "+N" expands that row's chips.
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const expandTags = useCallback(
    (n: string) => setExpandedTags((prev) => new Set(prev).add(n)),
    [],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  // Measured rather than assumed: the header chrome and the metrics both float
  // over the list, so the list needs to know exactly how much room to leave
  // before its first row.
  const [metricsHeight, setMetricsHeight] = useState(0);
  const [chromeHeight, setChromeHeight] = useState(0);
  const darkScheme = useColorScheme().colorScheme === "dark";

  useEffect(() => {
    if (!config.hydrated) return;
    void units.load(config);
    // The search box scans the full property (see units store `visible`), so the
    // whole set must be cached — not just the current page.
    if (units.allUnits.length === 0) void units.loadAll(config);
    if (!tagStore.hydrated) void tagStore.hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.hydrated, units.filter]);

  const rows = units.visible();
  const selected = rows.find((u) => u.resman_unit_id === selectedId) ?? null;

  // Drop a selection the current filter/search no longer shows, so the pane
  // never describes a tenant that isn't in the list.
  useEffect(() => {
    if (selectedId && !rows.some((u) => u.resman_unit_id === selectedId)) setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, selectedId]);

  const loadDetail = useCallback(
    async (unitId: string) => {
      setDetailLoading(true);
      setDetailError("");
      setDetail(null);
      try {
        setDetail(await getTenantDetail(unitId, config));
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Couldn't load tenant details");
      } finally {
        setDetailLoading(false);
      }
    },
    [config],
  );

  const select = useCallback(
    (unitId: string) => {
      setSelectedId(unitId);
      void loadDetail(unitId);
    },
    [loadDetail],
  );

  // Open on the top unit rather than an empty pane. Only when the detail is a
  // column: in the compact layout it's a sheet, and auto-selecting would throw it
  // over the list before the guard has asked for anything. This also refills the
  // pane when a filter change drops the previous selection.
  useEffect(() => {
    if (isCompact || selectedId || rows.length === 0) return;
    select(rows[0].resman_unit_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompact, selectedId, rows.length, select]);

  const openSettings = () => router.push("/settings");

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
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              // Clear the floating chrome + metrics, then keep the list's rhythm.
              paddingTop: chromeHeight + metricsHeight + 13,
              paddingBottom: insets.bottom + 96,
              gap: 13,
            }}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={units.loading}
                onRefresh={() => units.load(config)}
                tintColor="#70788F"
                progressViewOffset={chromeHeight + metricsHeight}
              />
            }
          >
            {units.error ? (
              <AppCardSurface kind="row">
                <View style={{ padding: 16, gap: 6 }}>
                  <Text className="text-status-blocked" style={{ fontSize: 15, fontWeight: "700" }}>
                    Couldn&apos;t load units
                  </Text>
                  <Text className="text-muted" style={{ fontSize: 14 }}>
                    {units.error}
                  </Text>
                </View>
              </AppCardSurface>
            ) : rows.length === 0 && !units.loading ? (
              <Text className="text-muted" style={{ fontSize: 14, paddingHorizontal: 4, paddingTop: 8 }}>
                {units.total === 0 ? "No units synced yet." : "No units match this view."}
              </Text>
            ) : (
              <View style={{ gap: 9 }}>
                {rows.map((u) => {
                  const status = unitStatus(u);
                  const isSelected = u.resman_unit_id === selectedId;
                  return (
                    <Pressable
                      key={u.resman_unit_id}
                      onPress={() => select(u.resman_unit_id)}
                      accessibilityRole="button"
                      accessibilityState={isSelected ? { selected: true } : {}}
                    >
                      <AppCardSurface kind="row">
                        <View
                          className="flex-row items-center"
                          style={{
                            padding: 14,
                            gap: 14,
                            // Selection reads as a ring rather than a fill, so the
                            // status badge keeps its meaning.
                            borderRadius: 18,
                            borderWidth: isSelected ? 2 : 0,
                            borderColor: isSelected ? "#A2A921" : "transparent",
                          }}
                        >
                          <View
                            className="items-center justify-center rounded-full"
                            style={{ width: 58, height: 58, backgroundColor: "#E9E6D1" }}
                          >
                            <Text style={{ color: "#848F0D", fontSize: 20, fontWeight: "700" }}>{unitInitials(u)}</Text>
                          </View>
                          <View className="flex-1">
                            <Text
                              className="text-navy dark:text-white"
                              style={{ fontSize: 17, fontWeight: "700" }}
                              numberOfLines={1}
                            >
                              {unitPrimaryName(u)}
                            </Text>
                            <Text
                              className="text-slate dark:text-white/70"
                              style={{ fontSize: 14, fontWeight: "500" }}
                              numberOfLines={1}
                            >
                              {unitLine(u)}
                            </Text>
                            {unitClassification(u) ? (
                              <Text className="text-muted" style={{ fontSize: 13, fontWeight: "500" }}>
                                {unitClassification(u)}
                              </Text>
                            ) : null}
                            <RowTagChips
                              tags={tagStore.tagsFor(u.number)}
                              expanded={expandedTags.has(u.number)}
                              onExpand={() => expandTags(u.number)}
                            />
                          </View>
                          <AppStatusBadge label={status.label} tint={status.tint} />
                        </View>
                      </AppCardSurface>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </ScrollView>

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
                  icon="people"
                  title="Total Units"
                  value={String(units.total)}
                  caption={lastSyncedLabel(units.units)}
                />
              </View>
              <View className="flex-1">
                <AppMetricCard
                  icon="funnel"
                  title="Showing"
                  value={String(rows.length)}
                  caption={units.search ? `matching “${units.search}”` : "all in view"}
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
        style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: insets.top + 26, paddingHorizontal: hPad, paddingBottom: 18 }}
      >
        <AppScreenHeader
          title="Tenants"
          subtitle="View and manage residents with secure building access."
          trailing={
            <>
              <AppSearchField value={units.search} onChangeText={units.setSearch} placeholder="Search tenants" width={240} />
              <Pressable
                onPress={openSettings}
                accessibilityLabel="Device setup"
                className="bg-white dark:bg-white/10"
                style={{ width: 44, height: 44, borderRadius: 999, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(9,27,84,0.12)" }}
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
        <View pointerEvents="box-none" className="flex-row flex-wrap" style={{ gap: 8, marginTop: 18 }}>
          {FILTERS.map((f) => (
            <AppFilterChip
              key={f.key}
              label={f.label}
              selected={units.filter === f.key}
              onPress={() => units.setFilter(f.key)}
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
              <Text className="text-navy dark:text-white" style={{ fontSize: 20, fontWeight: "700" }}>
                Tenant
              </Text>
              <Pressable onPress={() => setSelectedId(null)} hitSlop={10}>
                <Text className="text-slate dark:text-white/70" style={{ fontSize: 16, fontWeight: "600" }}>
                  Done
                </Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 32 }}>{detailCard}</ScrollView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

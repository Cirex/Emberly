import { Ionicons } from "@expo/vector-icons";
import { useShallow } from "zustand/react/shallow";
import { LinearGradient } from "expo-linear-gradient";
import { useColorScheme } from "nativewind";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnnotationEditorDialog } from "@/components/map/AnnotationEditorDialog";
import { TagEditorDialog } from "@/components/map/TagEditorDialog";
import { TourSheet } from "@/components/map/TourSheet";
import { SkiaMapCanvas, type PlaceMode } from "@/components/map/SkiaMapCanvas";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { useMapSearch } from "@/lib/stores/map-search";
import { GlassSurface } from "@/components/ui/GlassSurface";
import { AppStatusBadge } from "@emberly/ui";
import type { ResmanUnit } from "@/lib/api/units";
import { buildColorMap, legendFor, occupancyGroup, unitMatchesSearch } from "@emberly/core";
import { isNight } from "@/lib/map-daynight";
import { PLACED_UNITS, UNIT_COUNT } from "@/lib/map-data";
import { useAnnotationPhotos } from "@/lib/stores/annotation-photos";
import { useAnnotations } from "@/lib/stores/annotations";
import { useConfig } from "@/lib/stores/config";
import { useMapJump } from "@emberly/ui";
import { useSettings } from "@/lib/stores/settings";
import { tagExpiryBadge, useTags, type UnitTag } from "@/lib/stores/tags";
import { useLocalSearchParams } from "expo-router";
import { useMyDay } from "@/lib/stores/my-day";
import { useTour } from "@/lib/stores/tour";
import { useUnits } from "@/lib/stores/units";
import { CLASSIFICATION_TINT, MUTED, OLIVE, OLIVE_TEXT, STATUS_TINT } from "@/theme/tokens";

const OCC_TINT: Record<string, string> = {
  Occupied: STATUS_TINT.ready,
  Vacant: STATUS_TINT.accentBlue,
  "Notice to Vacate": STATUS_TINT.warning,
  "Under Eviction": STATUS_TINT.blocked,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export default function PropertyMapScreen() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const darkScheme = useColorScheme().colorScheme === "dark";
  const config = useConfig();
  // Select only what the map reads from the units store. It writes on every 60s
  // background poll (paged `units`, `total`, `search`, `filter`), and the map
  // uses none of those — only the full `allUnits` set — so a whole-store
  // subscription re-rendered this screen (and its Skia canvas) every tick.
  const units = useUnits(
    useShallow((s) => ({
      allUnits: s.allUnits,
      loadingAll: s.loadingAll,
      loadAll: s.loadAll,
    })),
  );
  const ann = useAnnotations();
  const tagStore = useTags();
  // The unit search field now lives in the floating tab bar (like the other
  // tabs); it drives this shared store, which this screen reads.
  const query = useMapSearch((s) => s.query);
  const [selected, setSelected] = useState<string | undefined>();
  // One toggle instead of the old mode chips: occupancy tint on or off.
  // Off by default, persisted with the rest of the device preferences.
  const occupancyTint = useSettings((s) => s.mapOccupancyTint);
  const setOccupancyTint = useSettings((s) => s.setMapOccupancyTint);
  const [placeMode, setPlaceMode] = useState<PlaceMode>("none");
  const [tagEditUnit, setTagEditUnit] = useState<string | undefined>();
  // Tour Mode (TourRoute.swift): while armed, unit taps toggle stops instead
  // of opening the tooltip. Device-local store, hydrated by zustand persist.
  const tour = useTour();
  // "Open in Map" from My Day: show the daily path's badges instead of the
  // manual tour's — unless the user is actively in manual Tour Mode, which
  // stays an independent feature and wins while it's on.
  const showMyPath = useLocalSearchParams<{ path?: string }>().path === "1";
  const myDayStops = useMyDay((s) => s.stops);
  const [tourSheetOpen, setTourSheetOpen] = useState(false);
  // Editing state lives in the store: sync() may swap a fresh pin's local id
  // for the server's while the dialog is open, and the dialog must follow.
  const editingId = useAnnotations((s) => s.editingId);
  const setEditingId = useAnnotations((s) => s.setEditing);

  const hPad = width >= 1040 ? 34 : 24;
  const [canvas, setCanvas] = useState({ w: width, h: height });
  const hasData = units.allUnits.length > 0;
  const night = isNight();

  const photos = useAnnotationPhotos();
  useEffect(() => {
    if (!ann.hydrated) void ann.hydrate();
    if (!photos.hydrated) void photos.hydrate();
    if (!tagStore.hydrated) void tagStore.hydrate();
  }, [config, ann, photos, tagStore]);

  useEffect(() => {
    if (config.hydrated && units.allUnits.length === 0 && !units.loadingAll) {
      void units.loadAll(config);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.hydrated]);

  const unitByNumber = useMemo(() => {
    const m = new Map<string, ResmanUnit>();
    for (const u of units.allUnits) m.set(u.number, u);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units.allUnits]);

  // Queued deletions stay in the store until the server confirms them — the
  // map should not show a pin the guard already deleted.
  const visibleAnnotations = useMemo(() => ann.annotations.filter((a) => !a.removed), [ann.annotations]);

  const colorMap = useMemo(
    () => (occupancyTint ? buildColorMap("occupancy", units.allUnits) : new Map()),
    [occupancyTint, units.allUnits],
  );
  const legend = useMemo(
    () => (occupancyTint ? legendFor("occupancy", units.allUnits) : []),
    [occupancyTint, units.allUnits],
  );
  // Search the synced ResMan record (unit number + street + tenant names), not
  // just the map's bare number — so "kingsgate" or a resident's name finds the
  // right units, falling back to number-only for any unit without synced data.
  const matched = useMemo(() => {
    if (!query.trim()) return new Set<string>();
    const bare = query.trim().toLowerCase();
    const out = new Set<string>();
    for (const u of PLACED_UNITS) {
      const data = unitByNumber.get(u.number);
      const hit = data ? unitMatchesSearch(data, query) : u.number.toLowerCase().includes(bare);
      if (hit) out.add(u.number);
    }
    return out;
  }, [query, unitByNumber]);
  const hasQuery = query.trim().length > 0;

  const selectedUnit = useMemo(
    () => (selected ? PLACED_UNITS.find((u) => u.number === selected) : undefined),
    [selected],
  );

  // The map opens centered on the leasing office — the property's natural origin.
  const home = useMemo(() => {
    const office = PLACED_UNITS.find((u) => u.number === "3613 KG-1");
    return office ? { x: office.cx, y: office.cy } : undefined;
  }, []);

  // "View on Map" handoff: select the unit (tooltip + highlight) and hand the
  // canvas a fly-to target.
  const jumpUnit = useMapJump((s) => s.unitNumber);
  const jumpSeq = useMapJump((s) => s.seq);
  const consumeJump = useMapJump((s) => s.consume);
  const requestJump = useMapJump((s) => s.request);
  const [focusTarget, setFocusTarget] = useState<{ x: number; y: number; seq: number } | undefined>();
  useEffect(() => {
    if (!jumpUnit) return;
    const target = PLACED_UNITS.find((u) => u.number === jumpUnit);
    consumeJump();
    if (!target) return;
    setEditingId(undefined);
    setSelected(jumpUnit);
    setFocusTarget({ x: target.cx, y: target.cy, seq: jumpSeq });
  }, [jumpUnit, jumpSeq, consumeJump, setEditingId]);

  // A search that highlights off-screen units reads as "no results". When the
  // query resolves to matches, fly to the center of the matched cells so the
  // highlights land in view instead of staying somewhere off the map.
  const searchFocusSeq = useRef(0);
  useEffect(() => {
    if (!hasQuery || matched.size === 0) return;
    const pts = PLACED_UNITS.filter((u) => matched.has(u.number));
    if (pts.length === 0) return;
    const xs = pts.map((u) => u.cx);
    const ys = pts.map((u) => u.cy);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    searchFocusSeq.current += 1;
    setFocusTarget({ x: cx, y: cy, seq: 900_000 + searchFocusSeq.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matched]);

  const selectedData = selected ? unitByNumber.get(selected) : undefined;
  const selectedGroup = selectedData ? occupancyGroup(selectedData) : undefined;
  const selectedTint = (selectedGroup && OCC_TINT[selectedGroup]) || MUTED;
  const editing = editingId ? ann.annotations.find((a) => a.id === editingId) : undefined;

  const clearOverlays = () => {
    setSelected(undefined);
    setEditingId(undefined);
    setTagEditUnit(undefined);
  };

  const onSelectUnit = (n: string) => {
    // Tour mode intercepts unit taps: toggle the stop, never open the
    // tooltip (PropertyMapState.handleTap's .tour branch).
    if (tour.tourMode && n) {
      tour.toggleStop(n);
      return;
    }
    setEditingId(undefined);
    // "" is a tap on empty map — dismiss, like the Swift tooltip.
    setSelected((prev) => (!n || prev === n ? undefined : n));
  };
  const onPlacePin = (nx: number, ny: number) => {
    const c = ann.add(nx, ny);
    setPlaceMode("none");
    clearOverlays();
    setEditingId(c.id);
  };
  const onSelectPin = (id: string) => {
    clearOverlays();
    setEditingId(id);
  };

  const toggleMode = (m: PlaceMode) => {
    clearOverlays();
    setPlaceMode((prev) => (prev === m ? "none" : m));
  };

  // One-shot fly-home; shares the focus channel with search/jump (distinct seq base).
  const homeSeq = useRef(0);
  const flyHome = () => {
    if (!home) return;
    homeSeq.current += 1;
    setFocusTarget({ x: home.x, y: home.y, seq: 800_000 + homeSeq.current });
  };

  /** One 44pt button inside the vertical glass control stack (Apple Maps style). */
  const StackBtn = ({
    icon,
    active,
    onPress,
    label,
    disabled,
    badge,
    first,
  }: {
    icon: React.ComponentProps<typeof Ionicons>["name"];
    active?: boolean;
    onPress: () => void;
    label: string;
    disabled?: boolean;
    badge?: number;
    first?: boolean;
  }) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      style={{
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        borderTopWidth: first ? 0 : 1,
        borderTopColor: "rgba(9,27,84,0.09)",
        backgroundColor: active ? "rgba(162,169,33,0.22)" : "transparent",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Ionicons name={icon} size={18} color={active ? OLIVE_TEXT : "#3E4763"} />
      {badge ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            minWidth: 15,
            height: 15,
            borderRadius: 8,
            paddingHorizontal: 3,
            backgroundColor: OLIVE,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 9, fontWeight: "800", color: "#FFFFFF" }}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
      {/* The map IS the screen (PropertyMapView.swift) — everything else
          floats over it. */}
      <View
        style={StyleSheet.absoluteFill}
        onLayout={(e) => setCanvas({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      >
        <SkiaMapCanvas
          width={canvas.w}
          height={canvas.h}
          colorMap={colorMap}
          matched={matched}
          hasQuery={hasQuery}
          selected={selectedUnit}
          annotations={visibleAnnotations}
          tourStops={
            tour.tourMode || tour.stops.length > 0
              ? tour.stops
              : showMyPath && myDayStops.length > 0
                ? myDayStops
                : undefined
          }
          night={night}
          placeMode={placeMode}
          showPlan
          selectedTint={selectedTint}
          home={home}
          focus={focusTarget}
          tooltip={
            selectedUnit ? (
              <UnitTooltipCard
                unit={selectedUnit}
                data={selectedData}
                tint={selectedTint}
                tags={tagStore.tagsFor(selectedUnit.number)}
                onEditTags={() => setTagEditUnit(selectedUnit.number)}
              />
            ) : null
          }
          onSelect={onSelectUnit}
          onPlacePin={onPlacePin}
          onSelectPin={onSelectPin}
        />
      </View>

      {/* Edge scrims: the map content darkens as it runs under the floating
          chrome and the tab bar, so both read cleanly at any zoom. */}
      <LinearGradient
        pointerEvents="none"
        colors={darkScheme ? ["rgba(0,0,0,0.62)", "rgba(0,0,0,0)"] : ["rgba(9,27,84,0.30)", "rgba(9,27,84,0)"]}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top + 118 }}
      />
      <LinearGradient
        pointerEvents="none"
        colors={darkScheme ? ["rgba(0,0,0,0)", "rgba(0,0,0,0.66)"] : ["rgba(9,27,84,0)", "rgba(9,27,84,0.34)"]}
        style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: insets.bottom + 132 }}
      />

      {/* Floating chrome, Option 2: the account avatar (unit search moved to
          the tab bar), then a single vertical glass control stack. */}
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: insets.top + 12, left: hPad, right: hPad, gap: 10 }}
      >
        <View pointerEvents="box-none" className="flex-row" style={{ justifyContent: "flex-end" }}>
          <AccountMenu />
        </View>

        <View pointerEvents="box-none" className="flex-row" style={{ justifyContent: "flex-end" }}>
          <GlassSurface radius={22} style={{ overflow: "hidden" }}>
            <View>
              <StackBtn icon="navigate-outline" onPress={flyHome} label="Recenter" first />
              <StackBtn
                icon="people-outline"
                active={occupancyTint}
                onPress={() => setOccupancyTint(!occupancyTint)}
                label="Occupancy tint"
                disabled={!hasData}
              />
              <StackBtn
                icon="location-outline"
                active={placeMode === "annotate"}
                onPress={() => toggleMode("annotate")}
                label="Annotate"
              />
              <StackBtn
                icon="footsteps-outline"
                active={tour.tourMode}
                onPress={() => {
                  clearOverlays();
                  setPlaceMode("none");
                  tour.setTourMode(!tour.tourMode);
                }}
                label="Tour mode"
              />
              <StackBtn
                icon="list"
                active={tourSheetOpen}
                onPress={() => setTourSheetOpen(true)}
                label="Tour stops"
                disabled={tour.stops.length === 0 && !tour.tourMode}
                badge={tour.stops.length || undefined}
              />
            </View>
          </GlassSurface>
        </View>

        {placeMode !== "none" || tour.tourMode ? (
          <View pointerEvents="none" style={{ alignItems: "center" }}>
            <View
              className="bg-navy"
              style={{ borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8, opacity: 0.92 }}
            >
              <Text style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "600" }}>
                {placeMode !== "none" ? "Tap the map to drop a pin" : "Tap units to add tour stops"}
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      {/* Legend — quiet glass card, bottom-left, only while the tint is on. */}
      {hasData && occupancyTint && !hasQuery && placeMode === "none" ? (
        <View pointerEvents="none" style={{ position: "absolute", left: hPad, bottom: insets.bottom + 118 }}>
          <GlassSurface radius={14}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 9, gap: 6 }}>
              {legend.map((l) => (
                <View key={l.label} className="flex-row items-center" style={{ gap: 6 }}>
                  <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: l.color }} />
                  <Text className="text-slate dark:text-white/70" style={{ fontSize: 11, fontWeight: "600" }}>
                    {l.label}
                  </Text>
                </View>
              ))}
            </View>
          </GlassSurface>
        </View>
      ) : null}

      {editing ? (
        <AnnotationEditorDialog annotation={editing} onClose={() => setEditingId(undefined)} />
      ) : null}

      {tagEditUnit ? (
        <TagEditorDialog unitNumber={tagEditUnit} config={config} onClose={() => setTagEditUnit(undefined)} />
      ) : null}

      {/* Leaf modal like FilterSheet — reads the tour store itself; locate
          rides the existing "View on Map" jump (select + fly-to). */}
      <TourSheet
        visible={tourSheetOpen}
        onClose={() => setTourSheetOpen(false)}
        onLocate={(unitNumber) => {
          setTourSheetOpen(false);
          requestJump(unitNumber);
        }}
      />
    </View>
  );
}

/**
 * The unit callout, anchored at the tapped unit (PropertyMapTooltips.swift's
 * mapTooltipCard): occupancy tint drives the leading accent stripe, the icon
 * disc, and the dividers; the body is caption-sized label/value rows. No close
 * button — tapping anywhere else on the map dismisses, as it did on iOS.
 */
function UnitTooltipCard({
  unit,
  data,
  tint,
  tags,
  onEditTags,
}: {
  unit: { number: string };
  data?: ResmanUnit;
  tint: string;
  tags: UnitTag[];
  onEditTags: () => void;
}) {
  const withAlpha = (hex: string, a: number) => {
    const n = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const locality = [data?.city?.trim(), data?.state?.trim()].filter(Boolean).join(", ");
  const layout =
    data?.bedrooms != null && data?.bathrooms != null
      ? `${data.bedrooms} bd · ${data.bathrooms} ba`
      : "—";
  const classification = data?.classification?.trim() || "—";
  const classTint =
    CLASSIFICATION_TINT[classification.toLowerCase() as keyof typeof CLASSIFICATION_TINT];
  const group = data ? occupancyGroup(data) : undefined;
  const statusLabel = group ?? (data ? "Unknown" : "No data");
  const occupant = data ? (data.tenant_names.length ? data.tenant_names.join(", ") : "Unoccupied") : "—";
  const subline = [unit.number, locality].filter(Boolean).join(" · ");

  return (
    <GlassSurface
      radius={20}
      style={{
        width: 250,
        shadowColor: "#000",
        shadowOpacity: 0.22,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 10 },
      }}
    >
      {/* Leading accent stripe, tinted by occupancy. */}
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: tint, zIndex: 2 }}
      />

      {/* Header: icon disc + address + occupancy status line. */}
      <View className="flex-row items-start" style={{ gap: 10, paddingVertical: 12, paddingLeft: 15, paddingRight: 13 }}>
        <View
          className="items-center justify-center"
          style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: withAlpha(tint, 0.16) }}
        >
          <Ionicons name="business" size={16} color={tint} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "800", letterSpacing: -0.2 }} numberOfLines={1}>
            {data?.street?.trim() || unit.number}
          </Text>
          <Text className="text-slate dark:text-white/55" style={{ fontSize: 11, fontWeight: "600" }} numberOfLines={1}>
            {subline}
          </Text>
          <View className="flex-row items-center" style={{ gap: 5, marginTop: 3 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tint }} />
            <Text style={{ fontSize: 10.5, fontWeight: "800", color: tint, textTransform: "uppercase", letterSpacing: 0.3 }}>
              {statusLabel}
            </Text>
          </View>
        </View>
      </View>

      {/* Fact grid: occupant / layout, then classification full-width. */}
      <View
        style={{
          marginHorizontal: 15,
          borderRadius: 12,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: "rgba(9,27,84,0.10)",
        }}
      >
        <View className="flex-row">
          <TooltipFact
            k="Classification"
            v={classification}
            vColor={classTint}
            style={{ flex: 1, borderRightWidth: 1, borderColor: "rgba(9,27,84,0.10)" }}
          />
          <TooltipFact k="Layout" v={layout} style={{ flex: 1 }} />
        </View>
        <TooltipFact k="Occupant" v={occupant} style={{ borderTopWidth: 1, borderColor: "rgba(9,27,84,0.10)" }} />
      </View>

      {/* Shared tags — read here, edit in the tag sheet (synced to every device). */}
      <View style={{ paddingHorizontal: 15, paddingTop: 12, paddingBottom: 14 }}>
        <Text className="text-slate dark:text-white/50" style={{ fontSize: 9, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 7 }}>
          Tags · shared
        </Text>
        <View className="flex-row items-center" style={{ gap: 6, flexWrap: "wrap" }}>
          {tags.map((t) => {
            const badge = tagExpiryBadge(t);
            return (
              <View
                key={t.id}
                className="flex-row items-center"
                style={{
                  gap: 4,
                  paddingVertical: 3,
                  paddingHorizontal: 8,
                  borderRadius: 999,
                  backgroundColor: withAlpha(t.colorHex, 0.16),
                  borderWidth: 0.5,
                  borderColor: withAlpha(t.colorHex, 0.4),
                }}
              >
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.colorHex }} />
                <Text style={{ fontSize: 10.5, fontWeight: "600", color: t.colorHex }}>{t.label}</Text>
                {badge ? (
                  <Text style={{ fontSize: 9, fontWeight: "700", color: t.colorHex, opacity: 0.75 }}>· {badge}</Text>
                ) : null}
              </View>
            );
          })}
          <Pressable
            onPress={onEditTags}
            hitSlop={6}
            className="flex-row items-center"
            style={{ gap: 3, paddingVertical: 3, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, borderStyle: "dashed", borderColor: withAlpha(tint, 0.45) }}
          >
            <Ionicons name={tags.length ? "pricetags" : "add"} size={10} color={tint} />
            <Text style={{ fontSize: 10.5, fontWeight: "700", color: tint }}>{tags.length ? "Edit" : "Add tag"}</Text>
          </Pressable>
        </View>
      </View>
    </GlassSurface>
  );
}

/** One cell in the tooltip fact grid — uppercase key over a bold value. */
function TooltipFact({
  k,
  v,
  vColor,
  style,
}: {
  k: string;
  v: string;
  vColor?: string;
  style?: object;
}) {
  return (
    <View style={[{ paddingVertical: 7, paddingHorizontal: 11, backgroundColor: "rgba(246,244,235,0.45)" }, style]}>
      <Text className="text-slate dark:text-white/50" style={{ fontSize: 9, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}>
        {k}
      </Text>
      {vColor ? (
        <Text style={{ fontSize: 12, fontWeight: "700", color: vColor, marginTop: 1 }} numberOfLines={1}>
          {v}
        </Text>
      ) : (
        <Text className="text-navy dark:text-white" style={{ fontSize: 12, fontWeight: "700", marginTop: 1 }} numberOfLines={1}>
          {v}
        </Text>
      )}
    </View>
  );
}

function OverlayCard({ children, hPad, row }: { children: React.ReactNode; hPad: number; row?: boolean }) {
  return (
    <View style={{ position: "absolute", left: hPad, right: hPad, bottom: 96 }}>
      <View
        className="bg-white dark:bg-night-surface"
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "rgba(9,27,84,0.10)",
          padding: 16,
          gap: 12,
          flexDirection: row ? "row" : "column",
          alignItems: row ? "center" : "stretch",
          shadowColor: "#000",
          shadowOpacity: 0.13,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 8 },
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Stepper({ label, value, onDown, onUp }: { label: string; value: string; onDown: () => void; onUp: () => void }) {
  return (
    <View className="flex-row items-center" style={{ gap: 6 }}>
      <Text className="text-muted" style={{ fontSize: 12, width: 42 }}>{label}</Text>
      <Pressable onPress={onDown} className="items-center justify-center" style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: "rgba(9,27,84,0.06)" }}>
        <Ionicons name="remove" size={16} color="#4C556F" />
      </Pressable>
      <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "600", minWidth: 34, textAlign: "center" }}>{value}</Text>
      <Pressable onPress={onUp} className="items-center justify-center" style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: "rgba(9,27,84,0.06)" }}>
        <Ionicons name="add" size={16} color="#4C556F" />
      </Pressable>
    </View>
  );
}

function EditorFooter({ onDelete, onDone, inline }: { onDelete: () => void; onDone: () => void; inline?: boolean }) {
  return (
    <View className="flex-row items-center" style={{ gap: 16, justifyContent: inline ? "flex-end" : "flex-end" }}>
      <Pressable onPress={onDelete}><Text style={{ color: "#D1382E", fontSize: 15, fontWeight: "700" }}>Delete</Text></Pressable>
      <Pressable onPress={onDone}><Text className="text-olive-dark" style={{ fontSize: 15, fontWeight: "700" }}>Done</Text></Pressable>
    </View>
  );
}

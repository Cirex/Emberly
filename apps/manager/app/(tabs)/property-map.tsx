import { useShallow } from "zustand/react/shallow";
import { LinearGradient } from "expo-linear-gradient";
import { useColorScheme } from "nativewind";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import {
  BALANCE_HEAT_LEGEND,
  buildGroupPaint,
  occupancyGroup,
  unitMatchesSearch,
  STATUS_TINT,
} from "@emberly/core";
import { useMapJump } from "@emberly/ui";
import { capture } from "@/lib/analytics";
import { GroupsSheet } from "@/components/map/GroupsSheet";
import { LegendCard } from "@/components/map/LegendCard";
import { LensPills } from "@/components/map/LensPills";
import { SkiaMapCanvas } from "@/components/map/SkiaMapCanvas";
import { UnitCallout } from "@/components/map/UnitCallout";
import { buildHeatPaint, heatTint } from "@/components/map/heat";
import { PLACED_UNITS } from "@/components/map/map-data";
import { AccountMenu } from "@/components/ui/AccountMenu";
import type { ResmanUnit } from "@/lib/api/units";
import { useMapGroups } from "@/lib/stores/map-groups";
import { useMapLens, type MapLens } from "@/lib/stores/map-lens";
import { useMapSearch } from "@/lib/stores/map-search";
import { useUnits } from "@/lib/stores/units";
import { HEADER_TOP_PAD, MUTED, screenHPad } from "@/theme/tokens";

/** Occupancy tint fallback for units the active lens leaves unpainted. */
const OCC_TINT: Record<string, string> = {
  Occupied: STATUS_TINT.ready,
  Vacant: STATUS_TINT.accentBlue,
  "Notice to Vacate": STATUS_TINT.warning,
  "Under Eviction": STATUS_TINT.blocked,
};

/**
 * Property map — the shared Skia site map with the manager's read lenses:
 * delinquency heat (balance ramp + eviction override) and the leasing filter
 * groups. Mirrors the maintenance map tab's anatomy — full-screen canvas
 * under the floating shell chrome (no BoardHeader), edge scrims, the tab
 * bar's search field driving lib/stores/map-search — trimmed of everything
 * write-shaped (annotations, utility drawing, tours).
 *
 * Data: useUnits().allUnits, fed by the app-wide sync tick — the map adds NO
 * sync participant of its own.
 */
export default function PropertyMapScreen() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const darkScheme = useColorScheme().colorScheme === "dark";

  // Select only what the map reads: the full set. The 60s poll rewrites other
  // slices of the store, and a whole-store subscription would re-render the
  // Skia canvas every tick for nothing (maintenance learned this the hard way).
  const allUnits = useUnits(useShallow((s) => s.allUnits));

  const query = useMapSearch((s) => s.query);
  const lens = useMapLens((s) => s.lens);
  const setLens = useMapLens((s) => s.setLens);
  const groups = useMapGroups((s) => s.groups);
  const [groupsSheetOpen, setGroupsSheetOpen] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();

  const hPad = screenHPad(width);
  const [canvas, setCanvas] = useState({ w: width, h: height });
  const hasData = allUnits.length > 0;

  const unitByNumber = useMemo(() => {
    const m = new Map<string, ResmanUnit>();
    for (const u of allUnits) m.set(u.number, u);
    return m;
  }, [allUnits]);

  // Lens paints. Both are cheap enough to keep warm; the colorMap picks.
  const heatPaint = useMemo(() => buildHeatPaint(allUnits), [allUnits]);
  const groupPaint = useMemo(() => buildGroupPaint(groups, allUnits, Date.now()), [groups, allUnits]);
  const colorMap = useMemo(
    () =>
      !hasData || lens === "none"
        ? new Map()
        : lens === "heat"
          ? heatPaint.colorMap
          : groupPaint.colorMap,
    [hasData, lens, heatPaint, groupPaint],
  );

  const onLens = (next: MapLens) => {
    if (next === lens) return;
    setLens(next);
    capture("map_lens_changed", { lens: next });
  };

  // Search the synced record (unit number + street + tenant names), falling
  // back to number-only for any unit without synced data.
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
  const selectedData = selected ? unitByNumber.get(selected) : undefined;

  // Callout tint: the active lens's color for the unit, else occupancy, else muted.
  const selectedTint = useMemo(() => {
    if (!selectedData) return MUTED;
    if (lens === "heat") {
      const heat = heatTint(selectedData);
      if (heat) return heat;
    }
    if (lens === "groups") {
      const paint = groupPaint.colorMap.get(selectedData.number);
      if (paint) return paint.stroke;
    }
    const group = occupancyGroup(selectedData);
    return (group && OCC_TINT[group]) || MUTED;
  }, [selectedData, lens, groupPaint]);

  // "View on Map" handoff: select the unit (callout + highlight) and hand the
  // canvas a fly-to target. Consume only while FOCUSED: the tab stays mounted
  // in the background, so without the gate a backgrounded map ate the jump the
  // moment it was requested and the selection was gone by the time the screen
  // actually appeared. Gated, the request survives until arrival.
  const jumpUnit = useMapJump((s) => s.unitNumber);
  const jumpSeq = useMapJump((s) => s.seq);
  const consumeJump = useMapJump((s) => s.consume);
  const [focusTarget, setFocusTarget] = useState<{ x: number; y: number; seq: number } | undefined>();
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );
  useEffect(() => {
    if (!isFocused || !jumpUnit) return;
    const target = PLACED_UNITS.find((u) => u.number === jumpUnit);
    consumeJump();
    if (!target) return;
    setSelected(jumpUnit);
    setFocusTarget({ x: target.cx, y: target.cy, seq: jumpSeq });
  }, [isFocused, jumpUnit, jumpSeq, consumeJump]);

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

  const onSelectUnit = (n: string) => {
    // "" is a tap on empty map — dismiss, like the Swift tooltip.
    const next = !n || selected === n ? undefined : n;
    if (next) {
      const data = unitByNumber.get(next);
      // Minimal analytics posture: no unit identifiers, only the shape.
      capture("map_unit_selected", {
        hasBalance: typeof data?.balance === "number" && data.balance > 0,
      });
    }
    setSelected(next);
  };

  // Heat legend from core's ramp, the two non-numeric labels localized.
  const heatLegendRows = useMemo(
    () =>
      BALANCE_HEAT_LEGEND.map((item, i) => ({
        label:
          i === 0
            ? t("map.legend.current")
            : i === BALANCE_HEAT_LEGEND.length - 1
              ? t("map.legend.eviction")
              : item.label,
        color: item.color,
      })),
    [t],
  );
  const groupLegendRows = useMemo(
    () =>
      groups
        .filter((g) => g.visible)
        .map((g) => ({ label: g.name, color: g.colorHex, count: groupPaint.counts.get(g.id) ?? 0 })),
    [groups, groupPaint],
  );

  return (
    <View style={{ flex: 1 }}>
      {/* The map IS the screen — everything else floats over it. */}
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
          selectedTint={selectedTint}
          focus={focusTarget}
          tooltip={
            selectedUnit ? (
              <UnitCallout
                unit={selectedUnit}
                data={selectedData}
                tint={selectedTint}
                onOpenTenant={() => {
                  // Stub: delinquency/tenant detail cross-nav lands with the
                  // tenant sheet. Analytics only for now.
                  capture("map_open_tenant_pressed", {
                    hasBalance: typeof selectedData?.balance === "number" && selectedData.balance > 0,
                  });
                }}
              />
            ) : null
          }
          onSelect={onSelectUnit}
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

      {/* Floating chrome: the account pill at the shared corner, then the
          active lens's legend under it (mockup places it top-right). */}
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: insets.top + HEADER_TOP_PAD, left: hPad, right: hPad, gap: 10 }}
      >
        {width >= 1040 ? null : (
          <View pointerEvents="box-none" className="flex-row" style={{ justifyContent: "flex-end" }}>
            <AccountMenu />
          </View>
        )}
        {hasData && !hasQuery && lens !== "none" ? (
          <View pointerEvents="box-none" className="flex-row" style={{ justifyContent: "flex-end" }}>
            {lens === "heat" ? (
              <LegendCard title={t("map.legend.heatTitle")} rows={heatLegendRows} />
            ) : (
              <LegendCard
                title={t("map.legend.groupsTitle")}
                rows={groupLegendRows}
                onEdit={() => setGroupsSheetOpen(true)}
                editLabel={t("map.legend.editGroups")}
              />
            )}
          </View>
        ) : null}
      </View>

      {/* Lens pills — bottom-left, above the tab bar (mockup's mappill). */}
      <View style={{ position: "absolute", left: hPad, bottom: insets.bottom + 92 }}>
        <LensPills lens={lens} onSelect={onLens} />
      </View>

      <GroupsSheet visible={groupsSheetOpen} counts={groupPaint.counts} onClose={() => setGroupsSheetOpen(false)} />
    </View>
  );
}

import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useColorScheme } from "nativewind";
import { useRef, useState, memo } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { Chip } from "@/components/work-orders/Chip";
import type { ScoreCard } from "@/lib/derived/score-cards";
import { useFieldMode } from "@/lib/stores/settings";
import type { WorkOrdersBoardMode } from "@/lib/stores/work-orders-view";
import {
  ANDROID_GLASS_HAIRLINE,
  ANDROID_HEADER_ELEVATION,
  OPAQUE_GLASS,
  androidGlassFill,
} from "@/theme/android-glass";
import { HAIRLINE, HEADER_TOP_PAD, MUTED, NAVY, screenHPad } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";

const MODES: { id: WorkOrdersBoardMode; labelKey: string; icon: string }[] = [
  { id: "open", labelKey: "workOrders.modes.open", icon: "file-tray-full-outline" },
  { id: "closed", labelKey: "workOrders.modes.closed", icon: "checkmark-circle-outline" },
  { id: "preventive", labelKey: "workOrders.modes.preventive", icon: "sync-outline" },
  { id: "hotSpots", labelKey: "workOrders.modes.hotSpots", icon: "flame-outline" },
];

/**
 * The Work Orders liquid-glass header (approved D3 rev 2, artifact 480091ba):
 * one frosted surface pinned to the top — the mode DROPDOWN pill ("Open · 208
 * ▾", Apple Music library-style title menu), the filters funnel + account chip,
 * and the three-stat score strip with context lines. The list scrolls beneath
 * and blurs through. Reports its measured height so the list can pad itself.
 */
/**
 * Memoized: the device trace put this at 26–28ms on every board update, and it
 * changes only when the mode, the counts or the score cards do — not when a row
 * somewhere in the list moves. Every prop the screen passes is stabilized
 * (see the useCallbacks at the call site), so this is a real cutoff rather than
 * a memo that never hits.
 */
export const GlassHeader = memo(function GlassHeader({
  mode,
  onMode,
  count,
  cards,
  onAction,
  showFilters,
  filterCount,
  onOpenFilters,
  onOpenInsights,
  onHeight,
}: {
  mode: WorkOrdersBoardMode;
  onMode: (mode: WorkOrdersBoardMode) => void;
  /** The visible row count for the pill (mode-aware). */
  count: number;
  /** The mode's score cards; card[0]'s count lives in the pill, 1..3 render as the strip. */
  cards: ScoreCard[];
  onAction: (action: NonNullable<ScoreCard["action"]>) => void;
  showFilters: boolean;
  filterCount: number;
  onOpenFilters: () => void;
  /** Opens the Closed insights sheet; the chip renders on the closed mode only. */
  onOpenInsights?: () => void;
  onHeight: (h: number) => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const field = useFieldMode();
  // Same rule as WorkspaceBackdrop: field mode is bright paper whatever the
  // system says, so it is light even in dark mode. Every surface below was
  // hardcoded light before — warm-paper fill, `tint="light"` blur, white pill —
  // which is why the header read as a lit slab floating on a near-black app.
  const dark = useColorScheme().colorScheme === "dark" && !field;
  // Android has no blur, so this header goes opaque: at 42% the work-order
  // rows scrolling under it showed through its own title. Field mode already
  // sits at 96% for the same reason and keeps its own value.
  const androidGlass = OPAQUE_GLASS && !field;
  const accent = palette.glassFor(dark);
  const ink = dark ? "#FFFFFF" : NAVY;
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const pillRef = useRef<View>(null);

  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const strip = cards.slice(1);

  const openMenu = () => {
    pillRef.current?.measureInWindow((x, y, _w, h) => {
      setAnchor({ top: y + h + 6, left: Math.max(x, 12) });
      setMenuOpen(true);
    });
    setTimeout(() => setMenuOpen((v) => (anchor === null ? true : v)), 80);
  };

  return (
    <View
      onLayout={(e) => onHeight(e.nativeEvent.layout.height)}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        borderBottomWidth: 1,
        borderBottomColor: dark
          ? "rgba(255,255,255,0.07)"
          : androidGlass
            ? ANDROID_GLASS_HAIRLINE
            : "rgba(255,255,255,0.55)",
        backgroundColor: androidGlass
          ? androidGlassFill("header", dark)
          : dark
            ? "rgba(18,22,29,0.52)"
            : field
              ? "rgba(250,247,240,0.96)"
              : "rgba(250,247,240,0.42)",
        shadowColor: dark ? "#000000" : NAVY,
        shadowOpacity: dark ? 0.34 : 0.08,
        shadowRadius: 15,
        shadowOffset: { width: 0, height: 8 },
        // ...all of which Android ignores. This header has work-order rows
        // moving continuously under it and no scrim, so it is the one surface
        // that would read as flush with the list without a real lift.
        ...(androidGlass ? { elevation: ANDROID_HEADER_ELEVATION } : null),
      }}
    >
      {!field && !OPAQUE_GLASS ? (
        <BlurView
          intensity={dark ? 34 : 42}
          tint={dark ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View style={{ paddingTop: insets.top + HEADER_TOP_PAD }}>
        {/* Row 1: mode dropdown pill · funnel · account */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: screenHPad(screenW),
            gap: 8,
          }}
        >
          <Pressable
            ref={pillRef}
            onPress={openMenu}
            accessibilityRole="button"
            accessibilityLabel={t("workOrders.modeMenuA11y", { mode: t(current.labelKey) })}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
              height: 42,
              paddingLeft: 9,
              paddingRight: 13,
              borderRadius: 999,
              backgroundColor: dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.60)",
              borderWidth: 1,
              borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.78)",
              shadowColor: dark ? "#000000" : NAVY,
              shadowOpacity: dark ? 0.3 : 0.12,
              shadowRadius: 9,
              shadowOffset: { width: 0, height: 4 },
            }}
          >
            <View
              style={{
                width: 25,
                height: 25,
                borderRadius: 13,
                backgroundColor: `${accent}26`,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name={current.icon as never} size={14} color={accent} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: "800", letterSpacing: -0.3, color: ink }}>
              {t(current.labelKey)}
            </Text>
            <View
              style={{
                minWidth: 24,
                height: 21,
                paddingHorizontal: 7,
                borderRadius: 999,
                backgroundColor: `${accent}24`,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "800",
                  color: accent,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {count.toLocaleString()}
              </Text>
            </View>
            <Ionicons name="chevron-down" size={12} color={MUTED} />
          </Pressable>
          <View style={{ flex: 1 }} />
          {mode === "closed" && onOpenInsights ? (
            <Chip
              icon="stats-chart-outline"
              onPress={onOpenInsights}
              accessibilityLabel={t("workOrders.insightsA11y")}
            />
          ) : null}
          {showFilters ? (
            <Chip
              icon="funnel-outline"
              active={filterCount > 0}
              badge={filterCount > 0 ? filterCount : undefined}
              onPress={onOpenFilters}
            />
          ) : null}
          <AccountMenu />
        </View>

        {/* Row 2: three-stat strip — the My Day metric treatment (big tinted
            tabular number, small sentence-case label, hairline dividers, no
            boxes) plus the Make Ready grid's context caption and chevron
            affordance, so both scorecard surfaces share one anatomy. */}
        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: screenHPad(screenW),
            paddingTop: 10,
            paddingBottom: 10,
          }}
        >
          {strip.map((card, i) => {
            const cell = (
              <View style={{ flex: 1, paddingRight: 10, paddingLeft: i === 0 ? 0 : 16 }}>
                {card.interactive ? (
                  <Ionicons
                    name="chevron-forward"
                    size={10}
                    color={dark ? "rgba(255,255,255,0.32)" : "rgba(9,27,84,0.28)"}
                    style={{ position: "absolute", top: 3, right: 4 }}
                  />
                ) : null}
                <Text
                  style={{
                    fontSize: 24,
                    fontWeight: "800",
                    letterSpacing: -0.5,
                    color: card.tint ?? accent,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {card.value}
                </Text>
                <Text
                  className="text-slate dark:text-white/60"
                  numberOfLines={1}
                  style={{ fontSize: 10, fontWeight: "600", marginTop: 1 }}
                >
                  {card.title}
                </Text>
                <Text
                  className="text-muted dark:text-white/45"
                  numberOfLines={1}
                  style={{ fontSize: 9, marginTop: 1 }}
                >
                  {card.caption}
                </Text>
              </View>
            );
            return (
              <View
                key={card.key}
                style={{
                  flex: 1,
                  flexDirection: "row",
                  borderLeftWidth: i === 0 ? 0 : 1,
                  borderLeftColor: HAIRLINE,
                }}
              >
                {card.interactive && card.action ? (
                  <Pressable
                    onPress={() => onAction(card.action as NonNullable<ScoreCard["action"]>)}
                    accessibilityRole="button"
                    style={{ flex: 1 }}
                  >
                    {cell}
                  </Pressable>
                ) : (
                  cell
                )}
              </View>
            );
          })}
        </View>
      </View>

      {/* The title menu — glass sheet anchored under the pill. */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setMenuOpen(false)}
          accessibilityLabel={t("workOrders.detail.close")}
        />
        <View
          style={{
            position: "absolute",
            top: anchor?.top ?? insets.top + 54,
            left: anchor?.left ?? 18,
            width: 216,
            borderRadius: 18,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: dark ? "rgba(255,255,255,0.10)" : "rgba(9,27,84,0.10)",
            backgroundColor: dark ? "rgba(28,33,41,0.97)" : "rgba(252,250,244,0.97)",
            shadowColor: dark ? "#000000" : NAVY,
            shadowOpacity: dark ? 0.5 : 0.28,
            shadowRadius: 30,
            shadowOffset: { width: 0, height: 12 },
            elevation: 12,
          }}
        >
          {MODES.map((m, i) => {
            const selected = m.id === mode;
            return (
              <Pressable
                key={m.id}
                onPress={() => {
                  setMenuOpen(false);
                  if (!selected) onMode(m.id);
                }}
                accessibilityRole="button"
                accessibilityState={selected ? { selected: true } : {}}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 9,
                  paddingHorizontal: 14,
                  minHeight: 44,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: dark ? "rgba(255,255,255,0.07)" : "rgba(9,27,84,0.06)",
                }}
              >
                <Ionicons
                  name={m.icon as never}
                  size={15}
                  color={selected ? accent : dark ? "rgba(255,255,255,0.58)" : "#4C556F"}
                />
                <Text
                  style={{
                    flex: 1,
                    fontSize: 13.5,
                    fontWeight: "700",
                    color: selected ? accent : ink,
                    letterSpacing: -0.1,
                  }}
                >
                  {t(m.labelKey)}
                </Text>
                {selected ? <Ionicons name="checkmark" size={15} color={accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </View>
  );
});

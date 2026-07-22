import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { useFieldMode } from "@/lib/stores/settings";
import { HAIRLINE, HEADER_TOP_PAD, MUTED, NAVY, OLIVE_GLASS, screenHPad } from "@/theme/tokens";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

/** One entry in the header's mode dropdown (the "Open · 208 ▾" pill). */
export interface BoardMode {
  key: string;
  /** Already-translated, sentence case. */
  label: string;
  icon: IoniconName;
  /** Shown in the pill's count lozenge when this mode is active. */
  count?: number;
}

/** One cell of the score-metric strip under the pill row. */
export interface BoardMetric {
  /** Already-formatted display value ("12", "94%", "$8.2k"). */
  value: string;
  /** Hex tint for the value; defaults to brand navy. */
  tint?: string;
  /** Sentence-case metric label. */
  label: string;
  /** Small context line under the label. */
  caption?: string;
  /**
   * Optional inline mini chart rendered after the label (the Trends
   * sparklines — see components/trends/Spark). The element itself decides
   * whether to render (Spark gates on 14 days of snapshots), so passing a
   * Spark unconditionally is safe.
   */
  spark?: ReactNode;
  /** When present the cell is pressable and shows the chevron affordance. */
  onPress?: () => void;
}

/**
 * The liquid-glass board header every manager tab pins to the top — a
 * generalized port of the maintenance app's GlassHeader (approved D3 rev 2):
 * one frosted surface holding the mode DROPDOWN pill (Apple Music
 * library-style title menu, with the active mode's count), optional trailing
 * chips, the AccountMenu, and a score-metric strip with context captions.
 * The list scrolls beneath and blurs through. Reports its measured height via
 * `onHeight` so the screen can pad its scroll content.
 *
 * With a single mode the pill renders inert (no chevron, no menu) — that is
 * the placeholder-tab configuration. With an empty `metrics` array the strip
 * row is omitted entirely.
 */
export function BoardHeader({
  modes,
  activeMode,
  onMode,
  metrics,
  trailing,
  onHeight,
}: {
  modes: BoardMode[];
  /** Key of the active mode; must match a `modes` entry. */
  activeMode: string;
  onMode: (key: string) => void;
  metrics: BoardMetric[];
  /** Optional chips between the pill and the account menu (filters etc.). */
  trailing?: ReactNode;
  onHeight: (h: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const field = useFieldMode();
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const pillRef = useRef<View>(null);

  const current = modes.find((m) => m.key === activeMode) ?? modes[0];
  const hasMenu = modes.length > 1;

  const openMenu = () => {
    if (!hasMenu) return;
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
        borderBottomColor: "rgba(255,255,255,0.55)",
        backgroundColor: field ? "rgba(250,247,240,0.96)" : "rgba(250,247,240,0.42)",
        shadowColor: NAVY,
        shadowOpacity: 0.08,
        shadowRadius: 15,
        shadowOffset: { width: 0, height: 8 },
      }}
    >
      {!field ? <BlurView intensity={42} tint="light" style={StyleSheet.absoluteFill} /> : null}
      <View style={{ paddingTop: insets.top + HEADER_TOP_PAD }}>
        {/* Row 1: mode dropdown pill · trailing chips · account */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: screenHPad(screenW),
            gap: 8,
            paddingBottom: metrics.length > 0 ? 0 : 10,
          }}
        >
          <Pressable
            ref={pillRef}
            onPress={openMenu}
            disabled={!hasMenu}
            accessibilityRole="button"
            accessibilityLabel={
              hasMenu ? `Viewing ${current?.label ?? ""}; change mode` : current?.label
            }
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
              height: 42,
              paddingLeft: 9,
              paddingRight: 13,
              borderRadius: 999,
              backgroundColor: "rgba(255,255,255,0.60)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.78)",
              shadowColor: NAVY,
              shadowOpacity: 0.12,
              shadowRadius: 9,
              shadowOffset: { width: 0, height: 4 },
            }}
          >
            <View
              style={{
                width: 25,
                height: 25,
                borderRadius: 13,
                backgroundColor: "rgba(132,143,13,0.15)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name={current?.icon ?? "ellipse"} size={14} color={OLIVE_GLASS} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: "800", letterSpacing: -0.3, color: NAVY }}>
              {current?.label ?? ""}
            </Text>
            {current?.count !== undefined ? (
              <View
                style={{
                  minWidth: 24,
                  height: 21,
                  paddingHorizontal: 7,
                  borderRadius: 999,
                  backgroundColor: "rgba(132,143,13,0.14)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{ fontSize: 11, fontWeight: "800", color: OLIVE_GLASS, fontVariant: ["tabular-nums"] }}
                >
                  {current.count.toLocaleString()}
                </Text>
              </View>
            ) : null}
            {hasMenu ? <Ionicons name="chevron-down" size={12} color={MUTED} /> : null}
          </Pressable>
          <View style={{ flex: 1 }} />
          {trailing}
          <AccountMenu />
        </View>

        {/* Row 2: score-metric strip — big tinted tabular number, small
            sentence-case label, context caption, hairline dividers, no boxes;
            chevron affordance on pressable cells. Omitted when empty. */}
        {metrics.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              paddingHorizontal: screenHPad(screenW),
              paddingTop: 10,
              paddingBottom: 10,
            }}
          >
            {metrics.map((metric, i) => {
              const cell = (
                <View style={{ flex: 1, paddingRight: 10, paddingLeft: i === 0 ? 0 : 16 }}>
                  {metric.onPress ? (
                    <Ionicons
                      name="chevron-forward"
                      size={10}
                      color="rgba(9,27,84,0.28)"
                      style={{ position: "absolute", top: 3, right: 4 }}
                    />
                  ) : null}
                  <Text
                    style={{
                      fontSize: 24,
                      fontWeight: "800",
                      letterSpacing: -0.5,
                      color: metric.tint || NAVY,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {metric.value}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 }}>
                    <Text
                      className="text-slate dark:text-white/60"
                      numberOfLines={1}
                      style={{ fontSize: 10, fontWeight: "600", flexShrink: 1 }}
                    >
                      {metric.label}
                    </Text>
                    {metric.spark}
                  </View>
                  {metric.caption ? (
                    <Text
                      className="text-muted dark:text-white/45"
                      numberOfLines={1}
                      style={{ fontSize: 9, marginTop: 1 }}
                    >
                      {metric.caption}
                    </Text>
                  ) : null}
                </View>
              );
              return (
                <View
                  key={`${metric.label}-${i}`}
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    borderLeftWidth: i === 0 ? 0 : 1,
                    borderLeftColor: HAIRLINE,
                  }}
                >
                  {metric.onPress ? (
                    <Pressable onPress={metric.onPress} accessibilityRole="button" style={{ flex: 1 }}>
                      {cell}
                    </Pressable>
                  ) : (
                    cell
                  )}
                </View>
              );
            })}
          </View>
        ) : null}
      </View>

      {/* The title menu — glass sheet anchored under the pill. */}
      {hasMenu ? (
        <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setMenuOpen(false)}
            accessibilityLabel="Close mode menu"
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
              borderColor: "rgba(9,27,84,0.10)",
              backgroundColor: "rgba(252,250,244,0.97)",
              shadowColor: NAVY,
              shadowOpacity: 0.28,
              shadowRadius: 30,
              shadowOffset: { width: 0, height: 12 },
              elevation: 12,
            }}
          >
            {modes.map((m, i) => {
              const selected = m.key === activeMode;
              return (
                <Pressable
                  key={m.key}
                  onPress={() => {
                    setMenuOpen(false);
                    if (!selected) onMode(m.key);
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
                    borderTopColor: "rgba(9,27,84,0.06)",
                  }}
                >
                  <Ionicons name={m.icon} size={15} color={selected ? OLIVE_GLASS : "#4C556F"} />
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 13.5,
                      fontWeight: "700",
                      color: selected ? OLIVE_GLASS : NAVY,
                      letterSpacing: -0.1,
                    }}
                  >
                    {m.label}
                  </Text>
                  {selected ? <Ionicons name="checkmark" size={15} color={OLIVE_GLASS} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

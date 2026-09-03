import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MUTED, NAVY } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";

/** The Make Ready screen's view modes (local to the tab, not persisted). */
export type MakeReadyMode = "turns" | "schedule" | "history" | "trend";

const MODES: { id: MakeReadyMode; labelKey: string; icon: string }[] = [
  { id: "turns", labelKey: "makeReady.modes.turns", icon: "construct-outline" },
  { id: "schedule", labelKey: "makeReady.modes.schedule", icon: "calendar-outline" },
  { id: "history", labelKey: "makeReady.modes.history", icon: "time-outline" },
  { id: "trend", labelKey: "makeReady.modes.trend", icon: "trending-up-outline" },
];

/**
 * The Make Ready mode dropdown pill — the GlassHeader title-menu anatomy
 * (icon disc, bold label, count badge, chevron; glass sheet anchored under the
 * pill) rebuilt locally so the Work Orders header stays untouched.
 */
export function MakeReadyModePill({
  mode,
  onMode,
  count,
}: {
  mode: MakeReadyMode;
  onMode: (mode: MakeReadyMode) => void;
  /** The visible row count for the pill (mode-aware). */
  count: number;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const ink = dark ? "#FFFFFF" : NAVY;
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const pillRef = useRef<View>(null);

  const current = MODES.find((m) => m.id === mode) ?? MODES[0];

  const openMenu = () => {
    pillRef.current?.measureInWindow((x, y, _w, h) => {
      setAnchor({ top: y + h + 6, left: Math.max(x, 12) });
      setMenuOpen(true);
    });
    setTimeout(() => setMenuOpen((v) => (anchor === null ? true : v)), 80);
  };

  return (
    <>
      <Pressable
        ref={pillRef}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={t("makeReady.modeMenuA11y", { mode: t(current.labelKey) })}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          height: 42,
          paddingLeft: 9,
          paddingRight: 13,
          borderRadius: 999,
          backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.60)",
          borderWidth: 1,
          borderColor: dark ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.78)",
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
            backgroundColor: `${palette.text}26`,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name={current.icon as never} size={14} color={palette.glass} />
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
            backgroundColor: `${palette.text}24`,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              fontSize: 11,
              fontWeight: "800",
              color: palette.glass,
              fontVariant: ["tabular-nums"],
            }}
          >
            {count.toLocaleString()}
          </Text>
        </View>
        <Ionicons name="chevron-down" size={12} color={dark ? "rgba(255,255,255,0.5)" : MUTED} />
      </Pressable>

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
            borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(9,27,84,0.10)",
            backgroundColor: dark ? "#1B1D20" : "rgba(252,250,244,0.97)",
            shadowColor: NAVY,
            shadowOpacity: 0.28,
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
                  borderTopColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
                }}
              >
                <Ionicons
                  name={m.icon as never}
                  size={15}
                  color={selected ? palette.glass : dark ? "rgba(255,255,255,0.72)" : "#4C556F"}
                />
                <Text
                  style={{
                    flex: 1,
                    fontSize: 13.5,
                    fontWeight: "700",
                    color: selected ? palette.glass : ink,
                    letterSpacing: -0.1,
                  }}
                >
                  {t(m.labelKey)}
                </Text>
                {selected ? <Ionicons name="checkmark" size={15} color={palette.glass} /> : null}
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </>
  );
}

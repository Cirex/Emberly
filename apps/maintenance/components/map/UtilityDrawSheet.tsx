import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LineStyle, LineWeight, UtilityPoint, UtilityType } from "@/lib/api/annotations";
import { PAGE_HEIGHT, PAGE_WIDTH } from "@/lib/map-data";
import { UTILITY_COLORS, runLengthLabel } from "@/lib/utility-lines";
import { FlowRow, StyleChip, StyleRow, WeightRow } from "@/components/map/UtilityStyleControls";
import { useAccentPalette } from "@/lib/hooks/use-accent";

const NAVY = "#091B54";
const MUTED = "#70788F";

export type UtilityDrawSubMode = "pin" | "line";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{ fontSize: 9, fontWeight: "800", letterSpacing: 1, color: MUTED }}>
      {children.toUpperCase()}
    </Text>
  );
}

/**
 * The "New run" sheet from the approved mockup — a NON-modal bottom panel
 * (the map above stays tappable to place points): TYPE chips, LINE style +
 * weight segments, FLOW chips, and a footer with the live point count (and
 * measured length once the plan is calibrated), Undo, and Finish. Pin mode
 * keeps just the type row and hint. The sub-mode is chosen in the Utilities
 * hub, so the sheet carries no Pin/Line toggle.
 */
export function UtilityDrawSheet({
  utilityType,
  subMode,
  points,
  lineStyle,
  lineWeight,
  flowArrows,
  onSelectType,
  onSelectStyle,
  onSelectWeight,
  onToggleArrows,
  onReverse,
  onUndo,
  onFinish,
  onCancel,
}: {
  utilityType: UtilityType;
  subMode: UtilityDrawSubMode;
  /** Vertices placed so far on the in-progress line. */
  points: UtilityPoint[];
  lineStyle: LineStyle;
  lineWeight: LineWeight;
  flowArrows: boolean;
  onSelectType: (t: UtilityType) => void;
  onSelectStyle: (s: LineStyle) => void;
  onSelectWeight: (w: LineWeight) => void;
  onToggleArrows: (on: boolean) => void;
  /** Flip the draft's direction (drives the flow chevrons). */
  onReverse: () => void;
  onUndo: () => void;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const line = subMode === "line";
  const canFinish = line && points.length >= 2;
  const length = line ? runLengthLabel(points, PAGE_WIDTH, PAGE_HEIGHT) : null;

  return (
    <View
      pointerEvents="box-none"
      // Floats ABOVE the tab bar capsule (bottom insets+8, height 62) — the
      // navigator renders the bar after screen content, so anything lower
      // would sit behind it.
      style={{ position: "absolute", left: 10, right: 10, bottom: insets.bottom + 80, zIndex: 40 }}
    >
      <View
        style={{
          backgroundColor: "rgba(250,247,240,0.985)",
          borderRadius: 22,
          paddingBottom: 12,
          shadowColor: "#091B54",
          shadowOpacity: 0.2,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
        }}
      >
        <View style={{ alignItems: "center", paddingTop: 8 }}>
          <View style={{ width: 34, height: 4, borderRadius: 2, backgroundColor: "rgba(9,27,84,0.16)" }} />
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingTop: 8 }}>
          <Text style={{ flex: 1, fontSize: 15, fontWeight: "800", letterSpacing: -0.2, color: NAVY }}>
            {line ? t("utility.newRun") : t("utility.newPin")}
          </Text>
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel={t("utility.cancel")}
            style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(9,27,84,0.06)", alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="close" size={13} color="#4C556F" />
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 18, paddingTop: 8, gap: 10 }}>
          <View style={{ gap: 6 }}>
            <SectionLabel>{t("utility.typeSection")}</SectionLabel>
            <View className="flex-row items-center" style={{ gap: 6, flexWrap: "wrap" }}>
              {(["water", "sewer", "gas", "electrical"] as const).map((type) => (
                <StyleChip
                  key={type}
                  label={t(`utility.types.${type}`)}
                  selected={utilityType === type}
                  onPress={() => onSelectType(type)}
                  preview={
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: UTILITY_COLORS[type] }} />
                  }
                />
              ))}
            </View>
          </View>

          {line ? (
            <>
              <View style={{ gap: 6 }}>
                <SectionLabel>{t("utility.lineSection")}</SectionLabel>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <StyleRow value={lineStyle} color={UTILITY_COLORS[utilityType]} onChange={onSelectStyle} />
                  <WeightRow value={lineWeight} onChange={onSelectWeight} />
                </View>
              </View>
              <View style={{ gap: 6 }}>
                <SectionLabel>{t("utility.flowSection")}</SectionLabel>
                <FlowRow
                  arrows={flowArrows}
                  onToggle={onToggleArrows}
                  onReverse={points.length >= 2 ? onReverse : undefined}
                />
              </View>

              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingTop: 8,
                  borderTopWidth: 1,
                  borderTopColor: "rgba(9,27,84,0.08)",
                }}
              >
                <Text style={{ flex: 1, fontSize: 11.5, color: "#4C556F", fontVariant: ["tabular-nums"] }}>
                  {points.length === 0
                    ? t("utility.lineHint")
                    : [t("utility.pointCount", { count: points.length }), length].filter(Boolean).join(" · ")}
                </Text>
                <Pressable
                  onPress={onUndo}
                  disabled={points.length === 0}
                  accessibilityRole="button"
                  style={{
                    borderRadius: 999,
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                    backgroundColor: "rgba(9,27,84,0.06)",
                    opacity: points.length === 0 ? 0.4 : 1,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#4C556F" }}>{t("utility.undo")}</Text>
                </Pressable>
                <Pressable
                  onPress={onFinish}
                  disabled={!canFinish}
                  accessibilityRole="button"
                  style={{
                    borderRadius: 999,
                    paddingHorizontal: 17,
                    paddingVertical: 7,
                    backgroundColor: `${palette.fill}EB`,
                    opacity: canFinish ? 1 : 0.4,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>{t("utility.finish")}</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Text style={{ fontSize: 11.5, color: "#4C556F" }}>{t("utility.pinHint")}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

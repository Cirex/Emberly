import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { GlassSurface } from "@/components/ui/GlassSurface";
import type { LineStyle, LineWeight, UtilityType } from "@/lib/api/annotations";
import { UTILITY_COLORS } from "@/lib/utility-lines";
import { FlowRow, StyleRow, WeightRow } from "@/components/map/UtilityStyleControls";

/** The types offered for drawing; 'other' exists on the wire but isn't drawn here. */
const DRAW_TYPES = ["water", "sewer", "gas", "electrical"] as const satisfies readonly UtilityType[];

export type UtilityDrawSubMode = "pin" | "line";

/** One small chip in the pill — type pick, sub-mode pick, or an action. */
function Chip({
  label,
  selected,
  dot,
  disabled,
  onPress,
}: {
  label: string;
  selected?: boolean;
  dot?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      className="flex-row items-center"
      style={{
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: selected ? "rgba(162,169,33,0.24)" : "rgba(9,27,84,0.06)",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} /> : null}
      <Text
        className={selected ? "text-navy dark:text-white" : "text-slate dark:text-white/70"}
        style={{ fontSize: 12, fontWeight: "700" }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Floating glass pill shown while utility draw mode is armed (top-left, like
 * the rest of the map chrome): pick a type, pick Pin or Line, then tap the
 * map — Undo/Done/Cancel manage the in-progress run.
 */
export function UtilityDrawPill({
  utilityType,
  subMode,
  vertexCount,
  lineStyle,
  lineWeight,
  flowArrows,
  onSelectType,
  onSelectSubMode,
  onSelectStyle,
  onSelectWeight,
  onToggleArrows,
  onReverse,
  onUndo,
  onDone,
  onCancel,
}: {
  utilityType: UtilityType;
  subMode: UtilityDrawSubMode;
  /** Vertices placed so far on the in-progress line. */
  vertexCount: number;
  /** Live presentation of the run being drawn (line sub-mode only). */
  lineStyle: LineStyle;
  lineWeight: LineWeight;
  flowArrows: boolean;
  onSelectType: (t: UtilityType) => void;
  onSelectSubMode: (m: UtilityDrawSubMode) => void;
  onSelectStyle: (s: LineStyle) => void;
  onSelectWeight: (w: LineWeight) => void;
  onToggleArrows: (on: boolean) => void;
  /** Flip the draft's direction (drives the flow chevrons). */
  onReverse: () => void;
  onUndo: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const canDone = subMode === "line" && vertexCount >= 2;
  const canUndo = subMode === "line" && vertexCount > 0;

  return (
    <GlassSurface radius={18}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
        {/* Type chips — the run's color previews on each chip's dot. */}
        <View className="flex-row items-center" style={{ gap: 6, flexWrap: "wrap" }}>
          {DRAW_TYPES.map((type) => (
            <Chip
              key={type}
              label={t(`utility.types.${type}`)}
              dot={UTILITY_COLORS[type]}
              selected={utilityType === type}
              onPress={() => onSelectType(type)}
            />
          ))}
        </View>

        {/* Pin | Line, then the in-progress line's controls. */}
        <View className="flex-row items-center" style={{ gap: 6 }}>
          <Chip label={t("utility.pin")} selected={subMode === "pin"} onPress={() => onSelectSubMode("pin")} />
          <Chip label={t("utility.line")} selected={subMode === "line"} onPress={() => onSelectSubMode("line")} />
          <View style={{ width: 6 }} />
          {subMode === "line" ? (
            <>
              <Chip label={t("utility.undo")} disabled={!canUndo} onPress={onUndo} />
              <Chip label={t("utility.done")} disabled={!canDone} onPress={onDone} />
            </>
          ) : null}
          <Chip label={t("utility.cancel")} onPress={onCancel} />
        </View>

        {/* The run's presentation, previewing live on the draft as it's drawn. */}
        {subMode === "line" ? (
          <View style={{ gap: 6 }}>
            <View className="flex-row items-center" style={{ gap: 8 }}>
              <StyleRow value={lineStyle} color={UTILITY_COLORS[utilityType]} onChange={onSelectStyle} />
              <WeightRow value={lineWeight} onChange={onSelectWeight} />
            </View>
            <FlowRow
              arrows={flowArrows}
              onToggle={onToggleArrows}
              onReverse={vertexCount >= 2 ? onReverse : undefined}
            />
          </View>
        ) : null}

        <Text className="text-slate dark:text-white/60" style={{ fontSize: 11, fontWeight: "600" }}>
          {subMode === "line" ? t("utility.lineHint") : t("utility.pinHint")}
        </Text>
      </View>
    </GlassSurface>
  );
}

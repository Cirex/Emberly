import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import type { LineStyle, LineWeight } from "@/lib/api/annotations";
import { LINE_STYLES, LINE_WEIGHTS } from "@/lib/api/annotations";

/**
 * The per-run presentation controls — style, weight, flow — shared by the
 * draw pill (styling the run being drawn) and the run inspector (restyling a
 * committed run). One source so the two surfaces can't drift.
 */

export function StyleChip({
  label,
  selected,
  onPress,
  preview,
  accessibilityLabel,
}: {
  label?: string;
  selected: boolean;
  onPress: () => void;
  preview?: React.ReactNode;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      className="flex-row items-center"
      style={{
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: selected ? "rgba(162,169,33,0.24)" : "rgba(9,27,84,0.06)",
      }}
    >
      {preview}
      {label ? (
        <Text
          className={selected ? "text-navy dark:text-white" : "text-slate dark:text-white/70"}
          style={{ fontSize: 12, fontWeight: "700" }}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A miniature of the stroke a style produces, in the run's color. Composed
 * from segment Views rather than borderStyle — RN's dashed/dotted borders
 * are unreliable on single-edge borders on iOS.
 */
export function LinePreview({
  style,
  color,
  width = 24,
  thickness = 2.5,
}: {
  style: LineStyle;
  color: string;
  width?: number;
  thickness?: number;
}) {
  const segments = style === "solid" ? 1 : style === "dashed" ? 3 : 5;
  const gap = style === "solid" ? 0 : 3;
  const segW = (width - gap * (segments - 1)) / segments;
  return (
    <View className="flex-row items-center" style={{ width, gap }}>
      {Array.from({ length: segments }, (_, i) => (
        <View
          key={i}
          style={{
            width: segW,
            height: thickness,
            borderRadius: thickness / 2,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

export function StyleRow({
  value,
  color,
  onChange,
}: {
  value: LineStyle;
  color: string;
  onChange: (s: LineStyle) => void;
}) {
  const { t } = useTranslation();
  const labels: Record<LineStyle, string> = {
    solid: t("utility.styleSolid"),
    dashed: t("utility.styleDashed"),
    dotted: t("utility.styleDotted"),
  };
  return (
    <View className="flex-row items-center" style={{ gap: 6 }}>
      {LINE_STYLES.map((s) => (
        <StyleChip
          key={s}
          selected={value === s}
          onPress={() => onChange(s)}
          accessibilityLabel={labels[s]}
          preview={<LinePreview style={s} color={color} />}
        />
      ))}
    </View>
  );
}

export function WeightRow({
  value,
  onChange,
}: {
  value: LineWeight;
  onChange: (w: LineWeight) => void;
}) {
  const { t } = useTranslation();
  const labels: Record<LineWeight, string> = {
    thin: t("utility.weightThin"),
    medium: t("utility.weightMedium"),
    thick: t("utility.weightThick"),
  };
  // Display initials; the a11y label carries the full word.
  return (
    <View className="flex-row items-center" style={{ gap: 6 }}>
      {LINE_WEIGHTS.map((w) => (
        <StyleChip
          key={w}
          label={labels[w][0].toUpperCase()}
          selected={value === w}
          onPress={() => onChange(w)}
          accessibilityLabel={labels[w]}
        />
      ))}
    </View>
  );
}

export function FlowRow({
  arrows,
  onToggle,
  onReverse,
}: {
  arrows: boolean;
  onToggle: (on: boolean) => void;
  /** Absent while a draw has fewer than 2 points — chip hidden. */
  onReverse?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center" style={{ gap: 6 }}>
      <StyleChip label={t("utility.flowOff")} selected={!arrows} onPress={() => onToggle(false)} />
      <StyleChip label={t("utility.flowOn")} selected={arrows} onPress={() => onToggle(true)} />
      {onReverse ? <StyleChip label={`⇄ ${t("utility.reverse")}`} selected={false} onPress={onReverse} /> : null}
    </View>
  );
}

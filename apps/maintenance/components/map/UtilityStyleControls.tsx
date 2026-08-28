import { useColorScheme } from "nativewind";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import type { LineStyle, LineWeight } from "@/lib/api/annotations";
import { LINE_STYLES, LINE_WEIGHTS } from "@/lib/api/annotations";
import { useAccentPalette } from "@/lib/hooks/use-accent";

/**
 * The per-run presentation controls — style, weight, flow — shared by the
 * draw pill (styling the run being drawn) and the run inspector (restyling a
 * committed run). One source so the two surfaces can't drift. Style and
 * weight are segmented controls, flow is chips (approved mockup).
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
  const palette = useAccentPalette();
  const dark = useColorScheme().colorScheme === "dark";
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
        backgroundColor: selected
          ? `${palette.fill}3D`
          : dark
            ? "rgba(255,255,255,0.08)"
            : "rgba(9,27,84,0.06)",
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

/** The mockup's segmented control: inset track, white raised active segment. */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  renderOption,
  accessibilityLabels,
  width,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  renderOption: (v: T, selected: boolean) => React.ReactNode;
  accessibilityLabels: Record<T, string>;
  /** Fixed width — auto-width parents (the glass pill) collapse flexed rows. */
  width: number;
}) {
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: dark ? "rgba(255,255,255,0.06)" : "rgba(9,27,84,0.055)",
        borderRadius: 10,
        padding: 3,
        gap: 3,
        width,
      }}
    >
      {options.map((v) => {
        const selected = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabels[v]}
            accessibilityState={{ selected }}
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: selected
                ? dark
                  ? "rgba(255,255,255,0.16)"
                  : "#FFFFFF"
                : "transparent",
              ...(selected
                ? {
                    shadowColor: "#091B54",
                    shadowOpacity: 0.12,
                    shadowRadius: 4,
                    shadowOffset: { width: 0, height: 2 },
                  }
                : {}),
            }}
          >
            {renderOption(v, selected)}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A miniature of the stroke a style produces. Composed from segment Views
 *  rather than borderStyle — RN's dashed/dotted borders are unreliable on
 *  single-edge borders on iOS. */
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
    <Segmented
      options={LINE_STYLES}
      value={value}
      onChange={onChange}
      accessibilityLabels={labels}
      width={138}
      renderOption={(s, selected) => <LinePreview style={s} color={selected ? color : "#8B92A8"} />}
    />
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
  const dark = useColorScheme().colorScheme === "dark";
  const labels: Record<LineWeight, string> = {
    thin: t("utility.weightThin"),
    medium: t("utility.weightMedium"),
    thick: t("utility.weightThick"),
  };
  // Single-letter faces (S/M/L style); the a11y label carries the full word.
  const shorts: Record<LineWeight, string> = {
    thin: t("utility.weightShortThin"),
    medium: t("utility.weightShortMedium"),
    thick: t("utility.weightShortThick"),
  };
  return (
    <Segmented
      options={LINE_WEIGHTS}
      value={value}
      onChange={onChange}
      accessibilityLabels={labels}
      width={112}
      renderOption={(w, selected) => (
        <Text
          style={{
            fontSize: 11,
            fontWeight: "800",
            color: selected
              ? dark
                ? "#FFFFFF"
                : "#091B54"
              : dark
                ? "rgba(255,255,255,0.72)"
                : "#4C556F",
          }}
        >
          {shorts[w]}
        </Text>
      )}
    />
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
      {onReverse ? (
        <StyleChip label={`⇄ ${t("utility.reverse")}`} selected={false} onPress={onReverse} />
      ) : null}
    </View>
  );
}

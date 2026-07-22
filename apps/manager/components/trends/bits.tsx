import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

/**
 * Visual atoms for the Trends sheet, ported 1:1 from the approved mockup
 * (manager-trends-renewals-reports.html, "Trends" section): the white chart
 * card with its title/caption/delta header row, the ▲/▼ delta text tinted by
 * whether the direction is GOOD (not merely up), the range chips, and the
 * sheet footer. Plain Views and Texts; the charts themselves live next door.
 */

export const TREND_COLORS = {
  navy: "#091B54",
  slate: "#4C556F",
  muted: "#70788F",
  olive: "#767B24",
  pos: "#33A666",
  bad: "#D1382E",
  amber: "#E38736",
  purple: "#7A6BC7",
} as const;

/** White chart card (mockup `.card`): title, muted caption, right-side delta. */
export function TrendCard({
  title,
  caption,
  right,
  children,
}: {
  title: string;
  caption?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        marginHorizontal: 14,
        marginVertical: 8,
        backgroundColor: "#FFFFFF",
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.08)",
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 12,
        shadowColor: TREND_COLORS.navy,
        shadowOpacity: 0.05,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <Text style={{ fontSize: 12.5, fontWeight: "800", color: TREND_COLORS.navy }}>{title}</Text>
        {caption ? <Text style={{ fontSize: 9.5, color: TREND_COLORS.muted }}>{caption}</Text> : null}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {children}
    </View>
  );
}

/**
 * "▲ 1.1 pt" / "▼ $6.1k" — arrow follows the SIGN, tint follows whether the
 * move is GOOD: a falling balance is green, a falling occupancy is red.
 */
export function DeltaText({
  delta,
  upIsGood,
  format,
  prefix,
  size = 9,
}: {
  delta: number;
  upIsGood: boolean;
  /** Formats |delta| ("6.1k" → caller adds units/currency). */
  format: (abs: number) => string;
  /** Text before the arrow (e.g. the current value: "92.4% · "). */
  prefix?: string;
  size?: number;
}) {
  const up = delta >= 0;
  const good = up === upIsGood;
  return (
    <Text
      style={{
        fontSize: size,
        fontWeight: "800",
        color: good ? TREND_COLORS.pos : TREND_COLORS.bad,
        fontVariant: ["tabular-nums"],
      }}
    >
      {prefix ?? ""}
      {up ? "▲" : "▼"} {format(Math.abs(delta))}
    </Text>
  );
}

/** Range chip ("12 months"), active in olive — the mockup's `.qc`. */
export function RangeChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={active ? { selected: true } : {}}
      style={{
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderWidth: 1,
        backgroundColor: active ? "rgba(162,169,33,0.14)" : "rgba(9,27,84,0.05)",
        borderColor: active ? "rgba(162,169,33,0.5)" : "rgba(9,27,84,0.12)",
      }}
    >
      <Text
        style={{
          fontSize: 10,
          fontWeight: "700",
          color: active ? TREND_COLORS.olive : TREND_COLORS.slate,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Legend caption line under a chart (mockup `.legend`). */
export function LegendNote({ children, right }: { children?: string; right?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 5 }}>
      {children ? (
        <Text style={{ flex: 1, fontSize: 8.5, fontWeight: "600", color: TREND_COLORS.muted }}>
          {children}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {right ? (
        <Text style={{ fontSize: 8.5, fontWeight: "600", color: TREND_COLORS.muted }}>{right}</Text>
      ) : null}
    </View>
  );
}

/** Colored square + label legend entry (aging buckets). */
export function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ fontSize: 8.5, fontWeight: "600", color: TREND_COLORS.muted }}>{label}</Text>
    </View>
  );
}

/** Centered muted footer line (mockup `.foot`). */
export function SheetFooter({ children }: { children: string }) {
  return (
    <Text
      style={{
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
        textAlign: "center",
        fontSize: 10.5,
        color: TREND_COLORS.muted,
      }}
    >
      {children}
    </Text>
  );
}

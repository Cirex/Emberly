import { Text, View } from "react-native";
import { MUTED } from "@/theme/tokens";

/**
 * The tiny bar-chart primitive the Leasing and Today boards share (mockup's
 * .bars/.barlbls): plain Views, no chart library. Each column holds one or
 * more bottom-aligned bars (paired series render side by side) with an
 * optional label underneath. Scale is linear against the tallest bar.
 */

export interface BarColumn {
  key: string;
  /** X-axis label under the column ("" hides it). */
  label: string;
  /** One bar per series, drawn left to right. */
  values: { value: number; color: string }[];
}

export function BarColumns({
  columns,
  height = 72,
  barRadius = 3,
}: {
  columns: BarColumn[];
  height?: number;
  barRadius?: number;
}) {
  const max = Math.max(1, ...columns.flatMap((c) => c.values.map((v) => v.value)));
  const hasLabels = columns.some((c) => c.label !== "");
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          height,
          gap: 6,
          borderBottomWidth: 1,
          borderBottomColor: "rgba(9,27,84,0.10)",
        }}
      >
        {columns.map((col) => (
          <View
            key={col.key}
            style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: 2, justifyContent: "center" }}
          >
            {col.values.map((bar, i) => (
              <View
                key={i}
                style={{
                  flex: 1,
                  maxWidth: 22,
                  height: Math.max((bar.value / max) * height, bar.value > 0 ? 3 : 1),
                  borderTopLeftRadius: barRadius,
                  borderTopRightRadius: barRadius,
                  backgroundColor: bar.color,
                }}
              />
            ))}
          </View>
        ))}
      </View>
      {hasLabels ? (
        <View style={{ flexDirection: "row", gap: 6, marginTop: 3 }}>
          {columns.map((col) => (
            <Text
              key={col.key}
              numberOfLines={1}
              style={{ flex: 1, fontSize: 8.5, fontWeight: "600", color: MUTED, textAlign: "center" }}
            >
              {col.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Series-swatch legend line under a chart. */
export function BarLegend({ entries }: { entries: { color: string; label: string }[] }) {
  return (
    <View style={{ flexDirection: "row", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
      {entries.map((e) => (
        <View key={e.label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: e.color }} />
          <Text style={{ fontSize: 10, fontWeight: "600", color: MUTED }}>{e.label}</Text>
        </View>
      ))}
    </View>
  );
}

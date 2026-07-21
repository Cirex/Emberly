import { Text, View } from "react-native";
import { DashedLine } from "@/components/utilities/primitives";
import type { MonthlySpendSeries } from "@/lib/derived/utility-exceptions";
import { MUTED } from "@/theme/tokens";

/**
 * The 12-month spend bar chart — plain Views, no chart deps. Bars scale to the
 * tallest month, spike months tint red, and a dashed average line floats at
 * the series mean (mockup `.bars.avgline`). Degrades to nothing rendered when
 * the series is empty (the caller shows its own empty line), and to flat
 * zero-height bars when totals are all zero — never NaN.
 */
export function SpendBarChart({
  series,
  monthLabel,
  height = 110,
}: {
  series: MonthlySpendSeries;
  /** "2026-07" → localized "Jul". */
  monthLabel: (month: string) => string;
  height?: number;
}) {
  const { bars, average, max } = series;
  if (bars.length === 0) return null;
  // Bottom offset of the average line inside the bar box; clamp inside.
  const avgFraction = max > 0 ? Math.min(average / max, 1) : 0;

  return (
    <View>
      <View style={{ height, flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
        {bars.map((bar) => (
          <View
            key={bar.month}
            accessibilityLabel={`${monthLabel(bar.month)}: ${Math.round(bar.total)}`}
            style={{
              flex: 1,
              height: Math.max(bar.fraction * height, bar.total > 0 ? 3 : 1),
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
              backgroundColor: bar.hot ? "#D1382E" : "rgba(162,169,33,0.75)",
            }}
          />
        ))}
        {avgFraction > 0 ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", left: 0, right: 0, bottom: avgFraction * height }}
          >
            <DashedLine />
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 4, marginTop: 4 }}>
        {bars.map((bar) => (
          <Text
            key={bar.month}
            numberOfLines={1}
            style={{ flex: 1, fontSize: 8, fontWeight: "600", color: MUTED, textAlign: "center" }}
          >
            {monthLabel(bar.month)}
          </Text>
        ))}
      </View>
    </View>
  );
}

import { Text, View } from "react-native";
import { AGING_COLORS, MONEY_COLORS } from "@/components/delinquency/bits";
import { fmtMoneyCompact } from "@/components/delinquency/format";
import type { agingDistribution } from "@/lib/derived/delinquency-view";

/**
 * The aging meter: one segmented horizontal bar (0-30 → 90+, green → deep
 * red) with bucket · amount labels underneath, sized by share of total owed.
 * Segments under 6% still render a sliver so every bucket stays visible.
 */
export function AgingMeter({ distribution }: { distribution: ReturnType<typeof agingDistribution> }) {
  const { segments, total } = distribution;
  if (total <= 0) return null;

  // Give every non-empty segment at least a visible share; labels wrap under
  // their segment when wide enough, else stack into a legend row.
  const flexes = segments.map((s) => (s.amount > 0 ? Math.max(s.percent, 0.06) : 0));

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
      <View style={{ flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden" }}>
        {segments.map((s, i) =>
          flexes[i] > 0 ? (
            <View key={s.bucket} style={{ flex: flexes[i], backgroundColor: AGING_COLORS[s.bucket] }} />
          ) : null,
        )}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 5 }}>
        {segments.map((s) => (
          <View key={s.bucket} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: AGING_COLORS[s.bucket] }} />
            <Text style={{ fontSize: 8.5, fontWeight: "700", color: MONEY_COLORS.muted }}>
              {s.bucket} · {fmtMoneyCompact(s.amount)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

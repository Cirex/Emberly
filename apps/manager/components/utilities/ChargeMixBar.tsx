import { Text, View } from "react-native";
import { SEGMENT_COLORS } from "@/components/utilities/primitives";
import type { ChargeSegment } from "@/lib/derived/utility-exceptions";
import { MUTED } from "@/theme/tokens";

/**
 * Horizontal charge-mix bar (mockup `.hbar`) with an optional legend — plain
 * Views, segment widths via flexGrow so fractions never need pixel math.
 * Renders nothing when there are no segments (the charge-extraction seam may
 * be empty in production); callers show their own fallback line.
 */
export function ChargeMixBar({
  segments,
  height = 12,
  legendLabel,
}: {
  segments: ChargeSegment[];
  height?: number;
  /** When present, a legend row renders under the bar. */
  legendLabel?: (segment: ChargeSegment) => string;
}) {
  if (segments.length === 0) return null;
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          height,
          borderRadius: height / 2,
          overflow: "hidden",
          backgroundColor: "rgba(9,27,84,0.06)",
        }}
      >
        {segments.map((s) => (
          <View
            key={s.key}
            style={{ flexGrow: Math.max(s.fraction, 0.001), backgroundColor: SEGMENT_COLORS[s.key] }}
          />
        ))}
      </View>
      {legendLabel ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            columnGap: 12,
            rowGap: 3,
            marginTop: 6,
          }}
        >
          {segments.map((s) => (
            <View key={s.key} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View
                style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: SEGMENT_COLORS[s.key] }}
              />
              <Text style={{ fontSize: 9.5, fontWeight: "600", color: MUTED }}>
                {legendLabel(s)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

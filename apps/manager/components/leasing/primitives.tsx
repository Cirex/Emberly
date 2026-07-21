import { ScrollView, Pressable, Text, View } from "react-native";
import { MUTED, NAVY } from "@/theme/tokens";

/**
 * Small shared pieces of the Leasing board (also reused by Today): the
 * section BAND label, the status PILL, and the quick-filter CHIP row —
 * straight ports of the mockup's band/pill/qc classes.
 */

/** Pill tone → mockup colors. */
export type PillTone = "good" | "blue" | "review" | "soon" | "late" | "neutral";

const PILL_COLORS: Record<PillTone, { bg: string; fg: string }> = {
  good: { bg: "rgba(51,166,102,0.14)", fg: "#1F7A47" },
  blue: { bg: "rgba(37,99,180,0.12)", fg: "#2563B4" },
  review: { bg: "rgba(122,107,199,0.16)", fg: "#5B4BA8" },
  soon: { bg: "rgba(227,135,54,0.16)", fg: "#B05E14" },
  late: { bg: "rgba(209,56,46,0.13)", fg: "#D1382E" },
  neutral: { bg: "rgba(9,27,84,0.08)", fg: "#4C556F" },
};

export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  const c = PILL_COLORS[tone];
  return (
    <View
      style={{
        alignSelf: "flex-end",
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: c.bg,
      }}
    >
      <Text style={{ fontSize: 10.5, fontWeight: "800", color: c.fg }}>{label}</Text>
    </View>
  );
}

/** Uppercased section band; `hot` = the urgent (red) variant. */
export function BandHeader({ label, hot = false, pad }: { label: string; hot?: boolean; pad: number }) {
  return (
    <View style={{ paddingHorizontal: pad, paddingTop: 16, paddingBottom: 7 }}>
      <Text
        style={{
          fontSize: 10,
          fontWeight: "800",
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: hot ? "#B23B33" : MUTED,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export interface QuickChip {
  key: string;
  label: string;
  count: number;
}

/** Horizontal quick-filter chip row with live counts. */
export function QuickChips({
  chips,
  active,
  onChip,
  pad,
}: {
  chips: QuickChip[];
  active: string;
  onChip: (key: string) => void;
  pad: number;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: pad, gap: 7, paddingVertical: 2 }}
    >
      {chips.map((chip) => {
        const on = chip.key === active;
        return (
          <Pressable
            key={chip.key}
            onPress={() => onChip(chip.key)}
            accessibilityRole="button"
            accessibilityState={on ? { selected: true } : {}}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 11,
              height: 28,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: on ? "rgba(118,123,36,0.55)" : "rgba(9,27,84,0.12)",
              backgroundColor: on ? "rgba(162,169,33,0.16)" : "rgba(255,255,255,0.55)",
            }}
          >
            <Text
              style={{
                fontSize: 11.5,
                fontWeight: "700",
                color: on ? "#5C6410" : NAVY,
                fontVariant: ["tabular-nums"],
              }}
            >
              {chip.label} · {chip.count.toLocaleString()}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

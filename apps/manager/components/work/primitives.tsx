import { Text, View } from "react-native";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * Small shared pieces of the Work board — the priority band label, the chip,
 * and the six-stage progress bar. Plain Views (no dependencies), matching the
 * Utilities/Leasing board vocabulary so the tabs read as one app.
 */

export type ChipTone = "emergency" | "high" | "normal" | "low" | "callback" | "blocked" | "ready" | "neutral";

const CHIP_COLORS: Record<ChipTone, { bg: string; fg: string }> = {
  emergency: { bg: "rgba(209,56,46,0.13)", fg: "#D1382E" },
  high: { bg: "rgba(227,135,54,0.16)", fg: "#B05E14" },
  normal: { bg: "rgba(37,99,180,0.12)", fg: "#2563B4" },
  low: { bg: "rgba(9,27,84,0.08)", fg: "#4C556F" },
  callback: { bg: "rgba(122,107,199,0.16)", fg: "#5B4BA8" },
  blocked: { bg: "rgba(209,56,46,0.13)", fg: "#D1382E" },
  ready: { bg: "rgba(51,166,102,0.14)", fg: "#1F7A47" },
  neutral: { bg: "rgba(9,27,84,0.08)", fg: "#4C556F" },
};

export function Chip({ label, tone = "neutral" }: { label: string; tone?: ChipTone }) {
  const c = CHIP_COLORS[tone];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: c.bg,
      }}
    >
      <Text style={{ fontSize: 10, fontWeight: "800", color: c.fg }}>{label}</Text>
    </View>
  );
}

/** Uppercased section band; `hot` = the urgent (red) variant. */
export function BandHeader({ label, hot = false }: { label: string; hot?: boolean }) {
  return (
    <View style={{ paddingTop: 16, paddingBottom: 7 }}>
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

/**
 * The turn's six stage slots as discrete segments — a manager reads position,
 * not percentage, so the bar is segmented rather than continuous. Blocked
 * segments go red so a stuck stage is visible without opening the row.
 */
export function StageBar({
  total,
  done,
  blocked = 0,
}: {
  total: number;
  done: number;
  blocked?: number;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 3, alignItems: "center" }}>
      {Array.from({ length: total }, (_, i) => {
        const isDone = i < done;
        // Blocked stages are the next ones up after the completed run.
        const isBlocked = !isDone && i < done + blocked;
        return (
          <View
            key={i}
            style={{
              flex: 1,
              height: 5,
              borderRadius: 3,
              backgroundColor: isDone ? "#33A666" : isBlocked ? "#D1382E" : "rgba(9,27,84,0.10)",
            }}
          />
        );
      })}
    </View>
  );
}

/** One label/value line in the detail sheet. */
export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: HAIRLINE,
      }}
    >
      <Text style={{ width: 108, fontSize: 11, fontWeight: "600", color: MUTED }}>{label}</Text>
      <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "600", color: NAVY }}>{value}</Text>
    </View>
  );
}

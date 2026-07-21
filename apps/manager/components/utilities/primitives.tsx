import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { ChargeSegmentKey } from "@/lib/derived/utility-exceptions";
import { MUTED, NAVY } from "@/theme/tokens";

/**
 * Small shared pieces for the Utilities board — quick chips, status pills,
 * section bands — matching the manager mockup's `.qc`, `.pill`, and `.band`
 * styles. Kept dependency-free (plain Views) like the charts.
 */

/** Charge-mix segment colors (mockup .hseg1–5). */
export const SEGMENT_COLORS: Record<ChargeSegmentKey, string> = {
  electric: "#2563B4",
  water_sewer: "#33A666",
  gas: "#E38736",
  other: "#7A6BC7",
  non_mlgw: "rgba(9,27,84,0.28)",
};

/** Quick-filter chip (mockup `.qc`). */
export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={selected ? { selected: true } : {}}
      style={{
        borderRadius: 999,
        paddingHorizontal: 11,
        paddingVertical: 5,
        borderWidth: 1,
        backgroundColor: selected ? "rgba(162,169,33,0.14)" : "rgba(9,27,84,0.05)",
        borderColor: selected ? "rgba(162,169,33,0.5)" : "rgba(9,27,84,0.12)",
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "700", color: selected ? "#767B24" : "#4C556F" }}>
        {label}
      </Text>
    </Pressable>
  );
}

export type PillTone = "ok" | "good" | "soon" | "late" | "neutral" | "review" | "blue";

const PILL_STYLES: Record<PillTone, { color: string; bg: string; border: string }> = {
  ok: { color: "#767B24", bg: "rgba(162,169,33,0.12)", border: "rgba(162,169,33,0.35)" },
  good: { color: "#33A666", bg: "rgba(51,166,102,0.09)", border: "rgba(51,166,102,0.3)" },
  soon: { color: "#B05E14", bg: "rgba(176,94,20,0.08)", border: "rgba(176,94,20,0.3)" },
  late: { color: "#FFFFFF", bg: "#D1382E", border: "#A32D2D" },
  neutral: { color: "#70788F", bg: "rgba(112,120,143,0.07)", border: "rgba(112,120,143,0.25)" },
  review: { color: "#7A6BC7", bg: "rgba(122,107,199,0.08)", border: "rgba(122,107,199,0.3)" },
  blue: { color: "#2563B4", bg: "rgba(37,99,180,0.08)", border: "rgba(37,99,180,0.3)" },
};

/** Status pill (mockup `.pill`). Pressable when `onPress` is given. */
export function StatusPill({
  label,
  tone,
  onPress,
}: {
  label: string;
  tone: PillTone;
  onPress?: () => void;
}) {
  const s = PILL_STYLES[tone];
  const body = (
    <View
      style={{
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 3.5,
        borderWidth: 1,
        backgroundColor: s.bg,
        borderColor: s.border,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ fontSize: 10, fontWeight: "800", color: s.color }}>{label}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={6}>
      {body}
    </Pressable>
  );
}

/** Letter-spaced section band inside a card (mockup `.band`). */
export function BandHeader({ text, hot }: { text: string; hot?: boolean }) {
  return (
    <Text
      style={{
        paddingHorizontal: 16,
        paddingTop: 13,
        paddingBottom: 5,
        fontSize: 10,
        fontWeight: "700",
        letterSpacing: 1,
        color: hot ? "#A32D2D" : MUTED,
        textTransform: "uppercase",
      }}
    >
      {text}
    </Text>
  );
}

/** Card-column section heading (mockup `.padcol h4`). */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontSize: 12.5,
        fontWeight: "800",
        color: NAVY,
        letterSpacing: -0.2,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

/** A row of evenly spaced hairline dashes — RN's dashed borders are flaky on
 *  hairlines, so the average line draws its own dashes. */
export function DashedLine({ color = "rgba(9,27,84,0.30)" }: { color?: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 4, overflow: "hidden", height: 1.5 }}>
      {Array.from({ length: 60 }, (_, i) => (
        <View key={i} style={{ width: 5, height: 1.5, backgroundColor: color, borderRadius: 1 }} />
      ))}
    </View>
  );
}

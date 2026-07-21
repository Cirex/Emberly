import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { AgingBucket, LeaseVerdict } from "@emberly/core";
import type { NextAction } from "@/lib/derived/delinquency-view";

/**
 * Shared visual atoms for the Money board — pills, chips, band headers, and
 * plain-View meter primitives. Everything is Views and Texts; no chart deps.
 */

export const MONEY_COLORS = {
  navy: "#091B54",
  slate: "#4C556F",
  muted: "#70788F",
  olive: "#767B24",
  pos: "#33A666",
  warn: "#B05E14",
  bad: "#D1382E",
  info: "#2563B4",
  purple: "#7A6BC7",
  deepRed: "#7A1F1F",
  orange: "#E38736",
} as const;

/** Aging meter segment colors, in AGING_BUCKETS order (mockup ag1..ag4). */
export const AGING_COLORS: Record<AgingBucket, string> = {
  "0-30": "#33A666",
  "31-60": "#E38736",
  "61-90": "#D1382E",
  "90+": "#7A1F1F",
};

type PillTone = "ok" | "good" | "soon" | "late" | "neutral" | "review" | "blue";

const PILL_STYLES: Record<PillTone, { color: string; bg: string; border: string }> = {
  ok: { color: "#767B24", bg: "rgba(162,169,33,0.12)", border: "rgba(162,169,33,0.35)" },
  good: { color: "#33A666", bg: "rgba(51,166,102,0.09)", border: "rgba(51,166,102,0.3)" },
  soon: { color: "#B05E14", bg: "rgba(176,94,20,0.08)", border: "rgba(176,94,20,0.3)" },
  late: { color: "#FFFFFF", bg: "#D1382E", border: "#A32D2D" },
  neutral: { color: "#70788F", bg: "rgba(112,120,143,0.07)", border: "rgba(112,120,143,0.25)" },
  review: { color: "#7A6BC7", bg: "rgba(122,107,199,0.08)", border: "rgba(122,107,199,0.3)" },
  blue: { color: "#2563B4", bg: "rgba(37,99,180,0.08)", border: "rgba(37,99,180,0.3)" },
};

export function Pill({ tone, label }: { tone: PillTone; label: string }) {
  const s = PILL_STYLES[tone];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderWidth: 1,
        backgroundColor: s.bg,
        borderColor: s.border,
      }}
    >
      <Text style={{ fontSize: 9, fontWeight: "800", color: s.color }}>{label}</Text>
    </View>
  );
}

/** Tone mapping for each next-action suggestion pill. */
export const SUGGESTION_TONES: Record<NextAction, PillTone> = {
  writeOff: "review",
  awaitCourt: "blue",
  escalate: "late",
  fileFed: "late",
  serveNotice: "soon",
  onTrack: "ok",
  call: "soon",
  watch: "neutral",
  review: "neutral",
};

export const VERDICT_TONES: Record<LeaseVerdict, PillTone> = {
  profitable: "good",
  marginal: "soon",
  loss: "late",
};

/** Quick-filter chip row entry. */
export function QuickChip({
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
        paddingVertical: 5,
        borderWidth: 1,
        backgroundColor: active ? "rgba(162,169,33,0.14)" : "rgba(9,27,84,0.05)",
        borderColor: active ? "rgba(162,169,33,0.5)" : "rgba(9,27,84,0.12)",
      }}
    >
      <Text style={{ fontSize: 10.5, fontWeight: "700", color: active ? MONEY_COLORS.olive : MONEY_COLORS.slate }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Uppercase section band header ("NEEDS ACTION · 12"). */
export function BandHeader({ label, count, hot }: { label: string; count?: number; hot?: boolean }) {
  return (
    <Text
      style={{
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 5,
        fontSize: 10,
        fontWeight: "700",
        letterSpacing: 1,
        textTransform: "uppercase",
        color: hot ? "#A32D2D" : MONEY_COLORS.muted,
      }}
    >
      {count !== undefined ? `${label} · ${count}` : label}
    </Text>
  );
}

/**
 * Thin horizontal meter with a tinted fill — the agent scorecard primitive.
 * `ratio` is 0..1 of the track; the tint scales green → olive → red via
 * `dangerAt` (the ratio at which the metric reads as bad).
 */
export function MeterBar({ ratio, dangerAt }: { ratio: number; dangerAt: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const danger = dangerAt > 0 ? clamped / dangerAt : 0;
  const tint =
    danger >= 1 ? MONEY_COLORS.bad : danger >= 0.5 ? "rgba(162,169,33,0.8)" : MONEY_COLORS.pos;
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: "rgba(9,27,84,0.07)", overflow: "hidden" }}>
      <View style={{ width: `${clamped * 100}%`, height: "100%", borderRadius: 3, backgroundColor: tint }} />
    </View>
  );
}

/** Plain-View vertical bar histogram with per-bar labels. */
export function Histogram({
  values,
  labels,
  color = "rgba(122,107,199,0.7)",
  height = 60,
}: {
  values: number[];
  labels: readonly string[];
  color?: string;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height }}>
        {values.map((v, i) => (
          <View
            key={labels[i] ?? i}
            style={{
              flex: 1,
              height: Math.max(2, (v / max) * height),
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
              backgroundColor: v > 0 ? color : "rgba(9,27,84,0.10)",
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 4, marginTop: 4 }}>
        {labels.map((label) => (
          <Text
            key={label}
            numberOfLines={1}
            style={{ flex: 1, fontSize: 7, fontWeight: "600", color: "#9BA0B3", textAlign: "center" }}
          >
            {label}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** Centered muted footer line under a list. */
export function ListFooter({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        paddingHorizontal: 16,
        paddingVertical: 14,
        textAlign: "center",
        fontSize: 10.5,
        color: MONEY_COLORS.muted,
      }}
    >
      {children}
    </Text>
  );
}

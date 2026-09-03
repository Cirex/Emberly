import { useColorScheme } from "nativewind";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { buildTurnThroughput, type MakeReadyGroup } from "@/lib/derived/make-ready";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * Make Ready · Trend mode: how many turns arrived and cleared each month, and
 * the board size that leaves behind.
 *
 * Built on `buildTurnThroughput`, which reads a turn's start from
 * `earliestReportedDate` and its finish from `latestCompletedDate` — the same
 * two primitives the Turns board and History mode already use. That is
 * deliberate: the trend can never tell a different story from the rows a
 * technician can scroll to.
 *
 * Drawn with plain Views rather than SVG, matching the Hot Spots sparkline.
 * Nine bars need no scenegraph, and it keeps the tab free of a second
 * rendering stack.
 */

const MONTHS_SHOWN = 9;
const CHART_H = 116;
const STARTED = "#2A78D6";
const FINISHED = "#EB6834";

/** Board size sits alongside arrivals on ONE scale — never a second y-axis. */
function niceMax(values: number[]): number {
  const peak = Math.max(...values, 1);
  const step = peak > 40 ? 20 : peak > 16 ? 10 : 5;
  return Math.max(Math.ceil(peak / step) * step, step);
}

function Tile({ label, value, tint }: { label: string; value: string; tint?: string }) {
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <View style={{ flex: 1, gap: 3 }}>
      <Text
        style={{
          fontSize: 9.5,
          fontWeight: "700",
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: dark ? "rgba(255,255,255,0.5)" : MUTED,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontSize: 20,
          fontWeight: "800",
          fontVariant: ["tabular-nums"],
          color: tint ?? (dark ? "#FFFFFF" : NAVY),
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function TurnTrend({
  groups,
  nowMs,
  pad,
}: {
  groups: MakeReadyGroup[];
  nowMs: number;
  pad: number;
}) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const months = useMemo(() => buildTurnThroughput(groups, nowMs, MONTHS_SHOWN), [groups, nowMs]);

  const max = niceMax(months.flatMap((m) => [m.started, m.finished, m.openAtClose]));
  const totalStarted = months.reduce((n, m) => n + m.started, 0);
  const totalFinished = months.reduce((n, m) => n + m.finished, 0);
  const openNow = months.at(-1)?.openAtClose ?? 0;

  const monthLabel = (ms: number) =>
    new Date(ms).toLocaleDateString(activeLocale(), { month: "short" });

  const hair = dark ? "rgba(255,255,255,0.07)" : HAIRLINE;
  const ink = dark ? "#FFFFFF" : NAVY;
  const soft = dark ? "rgba(255,255,255,0.5)" : MUTED;

  return (
    <View style={{ paddingHorizontal: pad, gap: 14 }}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Tile label={t("makeReady.trend.started")} value={String(totalStarted)} tint={STARTED} />
        <Tile label={t("makeReady.trend.finished")} value={String(totalFinished)} tint={FINISHED} />
        <Tile
          label={t("makeReady.trend.onBoard")}
          value={String(openNow)}
          tint={totalStarted > totalFinished ? FINISHED : undefined}
        />
      </View>

      {/* Legend — identity is never colour alone; each swatch is labelled. */}
      <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
        {[
          [STARTED, t("makeReady.trend.started")],
          [FINISHED, t("makeReady.trend.finished")],
        ].map(([c, label]) => (
          <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: c }} />
            <Text style={{ fontSize: 11, color: soft }}>{label}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 9, height: 2, borderRadius: 1, backgroundColor: soft }} />
          <Text style={{ fontSize: 11, color: soft }}>{t("makeReady.trend.onBoard")}</Text>
        </View>
      </View>

      <View
        accessibilityRole="image"
        accessibilityLabel={t("makeReady.trend.chartA11y", {
          started: totalStarted,
          finished: totalFinished,
          open: openNow,
        })}
        style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: CHART_H }}
      >
        {months.map((m) => {
          const h = (v: number) => Math.max(Math.round((v / max) * (CHART_H - 22)), v > 0 ? 3 : 0);
          const openH = h(m.openAtClose);
          return (
            <View key={m.monthMs} style={{ flex: 1, alignItems: "center", gap: 4 }}>
              <View
                style={{
                  height: CHART_H - 22,
                  width: "100%",
                  justifyContent: "flex-end",
                  alignItems: "center",
                }}
              >
                {/* Board size as a rule across the column — a line, not a
                    third bar, so it reads as a level rather than a quantity. */}
                {m.openAtClose > 0 ? (
                  <View
                    style={{
                      position: "absolute",
                      bottom: openH,
                      left: 0,
                      right: 0,
                      height: 1.5,
                      borderRadius: 1,
                      backgroundColor: soft,
                      opacity: 0.55,
                    }}
                  />
                ) : null}
                <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
                  <View
                    style={{
                      width: 9,
                      height: h(m.started),
                      borderRadius: 3,
                      backgroundColor: STARTED,
                    }}
                  />
                  <View
                    style={{
                      width: 9,
                      height: h(m.finished),
                      borderRadius: 3,
                      backgroundColor: FINISHED,
                    }}
                  />
                </View>
              </View>
              <Text style={{ fontSize: 9.5, color: soft }}>{monthLabel(m.monthMs)}</Text>
            </View>
          );
        })}
      </View>

      {/* The table view — the numbers are readable without decoding colour. */}
      <View style={{ borderTopWidth: 1, borderTopColor: hair }}>
        {months.map((m) => (
          <View
            key={m.monthMs}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 7,
              borderBottomWidth: 1,
              borderBottomColor: hair,
            }}
          >
            <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: ink }}>
              {monthLabel(m.monthMs)}
            </Text>
            {[
              [m.started, STARTED],
              [m.finished, FINISHED],
            ].map(([v, c], i) => (
              <Text
                key={i}
                style={{
                  width: 42,
                  textAlign: "right",
                  fontSize: 12,
                  fontVariant: ["tabular-nums"],
                  color: c as string,
                }}
              >
                {v}
              </Text>
            ))}
            <Text
              style={{
                width: 52,
                textAlign: "right",
                fontSize: 12,
                fontWeight: "700",
                fontVariant: ["tabular-nums"],
                color: ink,
              }}
            >
              {m.openAtClose}
            </Text>
          </View>
        ))}
      </View>

      <Text style={{ fontSize: 10.5, lineHeight: 15, color: soft }}>
        {t("makeReady.trend.footnote")}
      </Text>
    </View>
  );
}

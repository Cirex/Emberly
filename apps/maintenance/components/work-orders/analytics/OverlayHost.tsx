import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { BlurView } from "expo-blur";
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BarChart, LineChart, ScatterChart } from "@/components/charts/charts";
import { TechBadge } from "@/components/work-orders/rows";
import type { DerivedSnapshot } from "@/lib/derived/snapshot";
import { BREAKDOWN_COPY, type TechnicianSummary } from "@/lib/derived/technician-summary";
import { useWorkOrdersView, type AnalyticsOverlay } from "@/lib/stores/work-orders-view";
import { CALLBACK_TINT, CLASSIFICATION_TINT, HAIRLINE, MUTED, NAVY, OLIVE, OLIVE_TEXT } from "@/theme/tokens";

/**
 * The five analytics overlays (port of the Swift WorkspaceOverlay panels), in
 * the approved phone-native treatment: a full-height bottom sheet on phone —
 * every table reflowed into full-width stacking rows — and the centered glass
 * card on tablet, where the wide layouts have room. Which panel renders
 * follows view.activeOverlay, wired from the tappable score cards.
 */

const CALLBACK_TARGET = 0.05;
const OVER = "#B05E14";
const UNDER = "#2C6B44";

// ---------------------------------------------------------------------------
// Shared pieces

/** Bare metric strip (Option 2 language): big numbers, hairline dividers. */
function MetricStrip({ cells }: { cells: { label: string; value: string; tint?: string }[] }) {
  return (
    <View style={{ flexDirection: "row", marginTop: 14, marginBottom: 4 }}>
      {cells.map((c, i) => (
        <View
          key={c.label}
          style={{
            flex: 1,
            borderLeftWidth: i === 0 ? 0 : 1,
            borderLeftColor: HAIRLINE,
            paddingLeft: i === 0 ? 0 : 14,
          }}
        >
          <Text
            style={{ fontSize: 21, fontWeight: "800", letterSpacing: -0.5, color: c.tint ?? NAVY, fontVariant: ["tabular-nums"] }}
          >
            {c.value}
          </Text>
          <Text className="text-slate" style={{ fontSize: 9, fontWeight: "700", letterSpacing: 0.5, marginTop: 1 }}>
            {c.label.toUpperCase()}
          </Text>
        </View>
      ))}
    </View>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-muted" style={{ fontSize: 10, fontWeight: "800", letterSpacing: 1, marginTop: 16, marginBottom: 8 }}>
      {children.toUpperCase()}
    </Text>
  );
}

function PanelHeader({
  icon,
  tint,
  title,
  subtitle,
  onClose,
}: {
  icon: string;
  tint: string;
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 11,
          backgroundColor: `${tint}26`,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon as never} size={17} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <Text className="text-navy" style={{ fontSize: 17, fontWeight: "800", letterSpacing: -0.3 }}>
          {title}
        </Text>
        <Text className="text-muted" style={{ fontSize: 10.5, marginTop: 1 }}>
          {subtitle}
        </Text>
      </View>
      <Pressable
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: "rgba(9,27,84,0.07)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="close" size={14} color="#4C556F" />
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------

function OpenMonthlyPanel({ snapshot, onClose }: { snapshot: DerivedSnapshot; onClose: () => void }) {
  const { months, metrics } = snapshot.monthlyClassification;
  const cls = ["Ruby", "Diamond", "Legacy"] as const;
  const clsTint = (c: string) =>
    CLASSIFICATION_TINT[c.toLowerCase() as keyof typeof CLASSIFICATION_TINT] ?? MUTED;
  const maxOpen = Math.max(...months.map((m) => m.totalOpenCount), 1);
  const [expanded, setExpanded] = useState<number | null>(months[0]?.monthStartMs ?? null);

  return (
    <>
      <PanelHeader
        icon="list-outline"
        tint={OLIVE_TEXT}
        title="Open Work Orders"
        subtitle="Monthly open & closed by classification · rolling 6 months"
        onClose={onClose}
      />
      <MetricStrip
        cells={[
          { label: "Open", value: metrics.totalOpen.toLocaleString() },
          { label: "Closed", value: metrics.totalClosed.toLocaleString(), tint: "#3D9461" },
          { label: "Busiest month", value: metrics.busiestMonthLabel ?? "—", tint: "#2A66AC" },
        ]}
      />
      <SectionLabel>Open by month · tap a month for the split</SectionLabel>
      {months.map((m, i) => {
        const open = expanded === m.monthStartMs;
        return (
          <Pressable
            key={m.monthStartMs}
            onPress={() => setExpanded(open ? null : m.monthStartMs)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            style={{ paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: HAIRLINE }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text className="text-navy" style={{ fontSize: 13.5, fontWeight: "800", width: 64 }}>
                {m.monthLabel}
              </Text>
              <View style={{ flex: 1 }} />
              <Text className="text-slate" style={{ fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                <Text style={{ color: NAVY, fontWeight: "800" }}>{m.totalOpenCount}</Text> open ·{" "}
                {m.totalClosedCount} closed
              </Text>
              <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={12} color="rgba(9,27,84,0.3)" />
            </View>
            <View
              style={{
                flexDirection: "row",
                height: 10,
                borderRadius: 5,
                overflow: "hidden",
                marginTop: 7,
                backgroundColor: "rgba(9,27,84,0.05)",
              }}
            >
              {cls.map((c) =>
                m.openCounts[c] > 0 ? (
                  <View key={c} style={{ flex: m.openCounts[c], backgroundColor: clsTint(c), opacity: 0.78 }} />
                ) : null,
              )}
              {maxOpen > m.totalOpenCount ? <View style={{ flex: maxOpen - m.totalOpenCount }} /> : null}
            </View>
            {open
              ? cls.map((c) => (
                  <View
                    key={c}
                    style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingTop: 6, paddingLeft: 8 }}
                  >
                    <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: clsTint(c) }} />
                    <Text style={{ width: 70, fontSize: 11, fontWeight: "700", color: clsTint(c) }}>{c}</Text>
                    <Text className="text-navy" style={{ fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                      {m.openCounts[c]} open
                    </Text>
                    <View style={{ flex: 1 }} />
                    <Text className="text-slate" style={{ fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                      {m.closedCounts[c]} closed
                    </Text>
                  </View>
                ))
              : null}
          </Pressable>
        );
      })}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 10 }}>
        {cls.map((c) => (
          <View key={c} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: clsTint(c) }} />
            <Text className="text-slate" style={{ fontSize: 9.5, fontWeight: "600" }}>
              {c}
            </Text>
          </View>
        ))}
        <View style={{ flex: 1 }} />
        <Text className="text-muted" style={{ fontSize: 9 }}>
          Bar length = open vs busiest month
        </Text>
      </View>
    </>
  );
}

function SameWeekPanel({ snapshot, onClose, width }: { snapshot: DerivedSnapshot; onClose: () => void; width: number }) {
  const { points, metrics } = snapshot.sameWeek;
  return (
    <>
      <PanelHeader
        icon="analytics-outline"
        tint="#33A666"
        title="Closed Same Week Trend"
        subtitle="Rolling 90-day view of same-week close rate and days to close"
        onClose={onClose}
      />
      <MetricStrip
        cells={[
          { label: "Same-week rate", value: `${(metrics.overallRate * 100).toFixed(1)}%`, tint: "#33A666" },
          { label: "Avg days", value: metrics.averageDaysToClose.toFixed(1), tint: "#2563B4" },
          { label: "Closed", value: metrics.totalClosed.toLocaleString() },
        ]}
      />
      <SectionLabel>Same-week close rate (50% target)</SectionLabel>
      <LineChart
        width={width}
        points={points.map((p) => ({ x: p.weekStartMs, y: p.sameWeekCloseRate * 100 }))}
        color="#33A666"
        targetY={50}
        formatY={(v) => `${v.toFixed(0)}%`}
        formatX={(x) => new Date(x).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
      />
      <SectionLabel>Avg days to close (7-day target)</SectionLabel>
      <LineChart
        width={width}
        points={points.map((p) => ({ x: p.weekStartMs, y: p.averageDaysToClose }))}
        color="#3D87E0"
        targetY={7}
        formatY={(v) => v.toFixed(0)}
        formatX={(x) => new Date(x).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
      />
    </>
  );
}

function DaysToClosePanel({ snapshot, onClose, width }: { snapshot: DerivedSnapshot; onClose: () => void; width: number }) {
  const { buckets, metrics } = snapshot.daysToClose;
  return (
    <>
      <PanelHeader
        icon="bar-chart-outline"
        tint="#3D87E0"
        title="Days to Close Distribution"
        subtitle="Every closed work order with both dates, bucketed"
        onClose={onClose}
      />
      <MetricStrip
        cells={[
          { label: "Closed", value: metrics.totalClosed.toLocaleString() },
          {
            label: "Largest bucket",
            value: metrics.dominantBucket ? `${metrics.dominantBucket.key} days` : "—",
            tint: "#2563B4",
          },
        ]}
      />
      <SectionLabel>Distribution</SectionLabel>
      <BarChart width={width} bars={buckets.map((b) => ({ label: b.key, value: b.count }))} color="#3D87E0" />
    </>
  );
}

/** Full-width callback rate bar with the labeled 5% target tick. */
function RateLine({ fraction, target, over }: { fraction: number; target: number; over: boolean }) {
  return (
    <View style={{ paddingTop: 12, marginTop: 2 }}>
      <View style={{ height: 12, borderRadius: 6, backgroundColor: "rgba(9,27,84,0.06)" }}>
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.min(fraction * 100, 100)}%`,
            borderRadius: 6,
            backgroundColor: over ? "#D98A45" : "#7FB98E",
          }}
        />
        <View
          style={{
            position: "absolute",
            left: `${target * 100}%`,
            top: -3,
            bottom: -3,
            width: 2,
            borderRadius: 1,
            backgroundColor: NAVY,
            opacity: 0.5,
          }}
        />
        <Text
          className="text-slate"
          style={{ position: "absolute", left: `${target * 100}%`, top: -13, fontSize: 8, fontWeight: "700", marginLeft: -7 }}
        >
          5%
        </Text>
      </View>
    </View>
  );
}

function CallbacksPanel({
  snapshot,
  onClose,
  width,
  phone,
}: {
  snapshot: DerivedSnapshot;
  onClose: () => void;
  width: number;
  phone: boolean;
}) {
  const { metrics, details, completedBase, highestRate } = snapshot.callbacks;
  const [tech, setTech] = useState<string | null>(null);
  const shown = tech ? details.filter((d) => d.technician === tech) : details;
  const domain = Math.max((highestRate?.callbackRate ?? 0) * 1.25, CALLBACK_TARGET * 2, 0.01);
  return (
    <>
      <PanelHeader
        icon="arrow-undo-circle-outline"
        tint="#7A6BC7"
        title="Callback Analytics"
        subtitle="Attributed to the technician on the completed work order"
        onClose={onClose}
      />
      <MetricStrip
        cells={[
          { label: "Callbacks", value: details.length.toLocaleString(), tint: CALLBACK_TINT },
          {
            label: "Highest rate",
            value: highestRate ? `${(highestRate.callbackRate * 100).toFixed(1)}%` : "—",
            tint: OVER,
          },
          { label: "Completed base", value: completedBase.toLocaleString() },
        ]}
      />
      <SectionLabel>Rate by technician · target 5% · tap to filter details</SectionLabel>
      {metrics.length === 0 ? (
        <Text className="text-muted" style={{ fontSize: 11.5 }}>
          No callback signals in the current data.
        </Text>
      ) : (
        metrics.slice(0, 8).map((m, i) => {
          const over = m.callbackRate > CALLBACK_TARGET;
          return (
            <Pressable
              key={m.technician}
              onPress={() => setTech(tech === m.technician ? null : m.technician)}
              accessibilityRole="button"
              style={{
                paddingVertical: 9,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: HAIRLINE,
                opacity: tech && tech !== m.technician ? 0.45 : 1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <TechBadge name={m.technician} size={24} />
                <Text className="text-navy" numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", flexShrink: 1 }}>
                  {m.technician}
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={{ fontSize: 14, fontWeight: "800", color: over ? OVER : UNDER, fontVariant: ["tabular-nums"] }}>
                  {(m.callbackRate * 100).toFixed(1)}%
                </Text>
                <Text className="text-muted" style={{ fontSize: 10, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                  {m.callbackCount}/{m.completedCount}
                  {m.hasSmallSample ? " · small sample" : ""}
                </Text>
              </View>
              <RateLine fraction={m.callbackRate / domain} target={CALLBACK_TARGET / domain} over={over} />
            </Pressable>
          );
        })
      )}
      {/* The scatter duplicates what the bars + fractions already say at a size
          where its labels never fit on a phone — tablet only. */}
      {!phone && metrics.length > 1 ? (
        <>
          <SectionLabel>Volume vs rate</SectionLabel>
          <ScatterChart
            width={Math.min(width, 320)}
            targetY={CALLBACK_TARGET}
            points={metrics.slice(0, 10).map((m) => ({
              x: m.completedCount,
              y: m.callbackRate,
              size: m.callbackCount,
              label: m.technician
                .split(/\s+/)
                .map((p) => p[0])
                .join("")
                .slice(0, 2)
                .toUpperCase(),
            }))}
          />
        </>
      ) : null}
      <SectionLabel>{tech ? `Callback details · ${tech}` : "Callback details"}</SectionLabel>
      {shown.slice(0, 10).map((d) => (
        <View key={d.callbackId} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: "rgba(9,27,84,0.06)" }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <Text style={{ width: 58, fontSize: 10.3, fontWeight: "600", color: d.isOpen ? "#E38736" : "#3D9461" }}>
              {d.isOpen ? "Open" : "Closed"}
            </Text>
            <Text className="text-muted" style={{ fontSize: 10.3, flex: 1 }}>
              {d.unitNumber}
            </Text>
            <Text className="text-muted" style={{ fontSize: 10.3, fontVariant: ["tabular-nums"] }}>
              {d.gapDays !== null ? `Gap ${d.gapDays}d` : "—"}
            </Text>
          </View>
          <Text className="text-navy" style={{ fontSize: 11.8, fontWeight: "600", marginTop: 2 }}>
            {d.title || `#${d.callbackNumber}`}
          </Text>
        </View>
      ))}
      <Text className="text-muted" style={{ fontSize: 9.5, textAlign: "center", marginTop: 10 }}>
        Scorecard counts open callbacks only · details include closed
      </Text>
    </>
  );
}

/** One technician: name + total on top, their own mini period bar-grid under. */
function TechRow({
  row,
  columnLabels,
  columnMaxima,
  leader,
  averageHeader,
  first,
}: {
  row: TechnicianSummary["rows"][number];
  columnLabels: string[];
  columnMaxima: number[];
  leader: boolean;
  averageHeader: string;
  first: boolean;
}) {
  const rowMax = Math.max(...row.counts, 1);
  return (
    <View style={{ paddingVertical: 10, borderTopWidth: first ? 0 : 1, borderTopColor: HAIRLINE }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TechBadge name={row.technician} size={24} />
        <Text className="text-navy" numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", flexShrink: 1 }}>
          {row.technician}
        </Text>
        {leader ? <Ionicons name="trophy-outline" size={12} color="#C79433" /> : null}
        <View style={{ flex: 1 }} />
        <Text className="text-navy" style={{ fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] }}>
          {row.total}
        </Text>
        <Text className="text-muted" style={{ fontSize: 10, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          · {row.averagePerPeriod.toFixed(1)} {averageHeader.toLowerCase()}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
        {row.counts.map((c, i) => {
          const isMax = c > 0 && c === columnMaxima[i];
          return (
            <View key={i} style={{ flex: 1, alignItems: "center", gap: 3 }}>
              <View
                style={{
                  width: "100%",
                  height: 30,
                  borderRadius: 5,
                  backgroundColor: "rgba(9,27,84,0.06)",
                  justifyContent: "flex-end",
                  overflow: "hidden",
                }}
              >
                {c > 0 ? (
                  <View
                    style={{
                      height: `${(c / rowMax) * 100}%`,
                      borderRadius: 5,
                      backgroundColor: isMax ? OLIVE : "rgba(9,27,84,0.28)",
                    }}
                  />
                ) : null}
              </View>
              <Text
                style={{
                  fontSize: 9.5,
                  fontWeight: "700",
                  color: isMax ? OLIVE_TEXT : "#4C556F",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {c}
              </Text>
              <Text className="text-muted" numberOfLines={1} style={{ fontSize: 8, fontWeight: "700", letterSpacing: 0.4 }}>
                {columnLabels[i]?.toUpperCase()}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function TechnicianPanel({
  summary,
  period,
  onClose,
}: {
  summary: TechnicianSummary;
  period: "week" | "month";
  onClose: () => void;
}) {
  const copy = BREAKDOWN_COPY[period];
  const shortCols = period === "week" ? summary.columnLabels.map((l) => l.slice(0, 3)) : summary.columnLabels;
  const total = summary.rows.reduce((sum, r) => sum + r.total, 0);
  return (
    <>
      <PanelHeader
        icon={period === "week" ? "calendar-outline" : "calendar-number-outline"}
        tint={period === "week" ? "#33A666" : "#B05E14"}
        title={copy.title}
        subtitle={copy.subtitle}
        onClose={onClose}
      />
      {summary.rows.length === 0 ? (
        <Text className="text-muted" style={{ fontSize: 11.5, marginTop: 14 }}>
          {copy.empty}
        </Text>
      ) : (
        <>
          <MetricStrip
            cells={[
              { label: "Closed", value: total.toLocaleString() },
              { label: "Technicians", value: String(summary.rows.length) },
              {
                label: "Avg / tech",
                value: (total / Math.max(summary.rows.length, 1)).toFixed(1),
                tint: OLIVE_TEXT,
              },
            ]}
          />
          <SectionLabel>By technician · busiest column in olive</SectionLabel>
          {summary.rows.map((r, i) => (
            <TechRow
              key={r.technician}
              row={r}
              columnLabels={shortCols}
              columnMaxima={summary.columnMaxima}
              leader={summary.leaders.includes(r.technician)}
              averageHeader={copy.averageHeader}
              first={i === 0}
            />
          ))}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export function AnalyticsOverlayHost({ snapshot }: { snapshot: DerivedSnapshot }) {
  const overlay = useWorkOrdersView((s) => s.activeOverlay);
  const setOverlay = useWorkOrdersView((s) => s.setActiveOverlay);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const phone = width < 768;
  const cardWidth = Math.min(width - 32, 680);
  const chartWidth = phone ? width - 40 : cardWidth - 36;
  const close = () => setOverlay(null);

  const panel = (o: NonNullable<AnalyticsOverlay>) => {
    switch (o) {
      case "openMonthly":
        return <OpenMonthlyPanel snapshot={snapshot} onClose={close} />;
      case "sameWeek":
        return <SameWeekPanel snapshot={snapshot} onClose={close} width={chartWidth} />;
      case "daysToClose":
        return <DaysToClosePanel snapshot={snapshot} onClose={close} width={chartWidth} />;
      case "callbacks":
        return <CallbacksPanel snapshot={snapshot} onClose={close} width={chartWidth} phone={phone} />;
      case "technicianWeek":
        return <TechnicianPanel summary={snapshot.weeklySummary} period="week" onClose={close} />;
      case "technicianMonth":
        return <TechnicianPanel summary={snapshot.monthlySummary} period="month" onClose={close} />;
    }
  };

  // Phone: a full-height sheet sliding over the dimmed workspace (HIG sheets).
  if (phone) {
    return (
      <Modal visible={overlay !== null} transparent animationType="slide" onRequestClose={close}>
        <View style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)", justifyContent: "flex-end" }}>
          <Pressable style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }} onPress={close} />
          <View
            style={{
              height: "88%",
              borderTopLeftRadius: 30,
              borderTopRightRadius: 30,
              backgroundColor: "rgba(252,250,244,0.99)",
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: "rgba(255,255,255,0.6)",
              shadowColor: NAVY,
              shadowOpacity: 0.35,
              shadowRadius: 40,
              shadowOffset: { width: 0, height: -12 },
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: 38,
                height: 5,
                borderRadius: 3,
                backgroundColor: "rgba(9,27,84,0.18)",
                alignSelf: "center",
                marginTop: 10,
                marginBottom: 8,
              }}
            />
            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 28 }}
              showsVerticalScrollIndicator={false}
            >
              {overlay ? panel(overlay) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  }

  // Tablet: the centered liquid-glass card — the wide layouts have room here.
  return (
    <Modal visible={overlay !== null} transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.32)", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Pressable style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }} onPress={close} />
        <View
          style={{
            width: cardWidth,
            maxHeight: "86%",
            borderRadius: 26,
            shadowColor: NAVY,
            shadowOpacity: 0.3,
            shadowRadius: 40,
            shadowOffset: { width: 0, height: 18 },
            elevation: 12,
          }}
        >
          <View style={{ borderRadius: 26, overflow: "hidden" }}>
            <BlurView intensity={44} tint="light">
              <View
                style={{
                  borderRadius: 26,
                  backgroundColor: "rgba(252,250,244,0.72)",
                  borderWidth: 1,
                  borderColor: "rgba(255,255,255,0.35)",
                }}
              >
                <ScrollView contentContainerStyle={{ padding: 18 }}>{overlay ? panel(overlay) : null}</ScrollView>
              </View>
            </BlurView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

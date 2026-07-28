import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useMapJump } from "@emberly/ui";
import { capture } from "@/lib/analytics";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { ClassificationChip, ColumnHeader, WorkOrderRow } from "@/components/work-orders/rows";
import {
  hotSpotSparkline,
  hotSpotTopTrade,
  hotSpotWeeklyTrend,
  type HotSpotRow,
} from "@/lib/derived/hot-spots";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { abbreviatedDate } from "@/lib/derived/time";
import { CALLBACK_TINT, HAIRLINE, HAIRLINE_SOFT, MUTED } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";

/**
 * Hot Spots mode, full-screen redesign: a property-wide "signals per week"
 * trend strip, then the risk-ranked units as full-bleed rows grouped into
 * High risk / Watch bands — each row carrying its rank, a risk meter, signal
 * chips, a 6-week sparkline, and a map-pin jump. Tapping a row still opens
 * the unit's 90-day detail pane (phone swaps views; tablet shows list and
 * detail side by side).
 */

const DETAIL_CAP = 12;

const RED = "#D1382E";
const AMBER = "#B05E14";
const HIGH_BAND_LABEL = "#A32D2D";
const HIGH_ROW_WASH = "rgba(226,75,74,0.05)";
const BAR_MUTED = "rgba(209,56,46,0.35)";
const SPARK = "rgba(209,56,46,0.4)";
const CALLBACK_CHIP = "#D4537E";
const OPEN_CHIP = "#2563B4";

const RISK_TINTS: Record<HotSpotRow["riskLevel"], { fg: string; bg: string }> = {
  High: { fg: RED, bg: "rgba(209,56,46,0.12)" },
  Watch: { fg: AMBER, bg: "rgba(235,133,46,0.13)" },
  Monitor: { fg: OPEN_CHIP, bg: "rgba(61,135,224,0.12)" },
};

function rowSignal(wo: ParsedWorkOrder): "callback" | "duplicate" | null {
  if (wo.callbackStatus === "possible" || wo.callbackStatus === "confirmed") return "callback";
  if (wo.isDuplicate) return "duplicate";
  return null;
}

// ── Trend strip ─────────────────────────────────────────────────────────────

const TREND_H = 42;

/** "Signals per week": 8 weekly bars, the two busiest weeks in solid red. */
function TrendStrip({ rows, nowMs, pad }: { rows: HotSpotRow[]; nowMs: number; pad: number }) {
  const { t } = useTranslation();
  const buckets = useMemo(() => hotSpotWeeklyTrend(rows, nowMs), [rows, nowMs]);
  const max = Math.max(...buckets, 1);
  const topSet = useMemo(() => {
    const ranked = buckets
      .map((v, i) => ({ v, i }))
      .filter((b) => b.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 2);
    return new Set(ranked.map((b) => b.i));
  }, [buckets]);
  return (
    <View style={{ paddingHorizontal: pad, marginBottom: 14 }}>
      <Text
        className="text-muted dark:text-white/50"
        style={{ fontSize: 10, fontWeight: "800", letterSpacing: 1 }}
      >
        {t("hotSpots.signalsPerWeek").toUpperCase()}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 5, height: TREND_H, marginTop: 8 }}>
        {buckets.map((v, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: Math.max(Math.round((v / max) * TREND_H), v > 0 ? 4 : 2),
              borderRadius: 2,
              backgroundColor: topSet.has(i) ? RED : BAR_MUTED,
            }}
          />
        ))}
      </View>
    </View>
  );
}

// ── Ranked rows ─────────────────────────────────────────────────────────────

/** 74px risk meter track + tinted numeric score. */
function RiskMeter({ score, high }: { score: number; high: boolean }) {
  const color = high ? RED : AMBER;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 74,
          height: 4,
          borderRadius: 2,
          backgroundColor: "rgba(9,27,84,0.08)",
          overflow: "hidden",
        }}
      >
        <View
          style={{ width: `${Math.min(score, 100)}%`, height: 4, borderRadius: 2, backgroundColor: color }}
        />
      </View>
      <Text style={{ fontSize: 12, fontWeight: "800", fontVariant: ["tabular-nums"], color }}>{score}</Text>
    </View>
  );
}

/** The ChipTag pill anatomy from My Day, tinted per signal. */
function SignalChip({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2.5,
        borderRadius: 999,
        backgroundColor: `${color}14`,
        borderWidth: 1,
        borderColor: `${color}42`,
      }}
    >
      <Text style={{ fontSize: 9.5, fontWeight: "700", color }}>{label}</Text>
    </View>
  );
}

/** Six tiny weekly bars for one unit's recent tickets. */
function Sparkline({ row, nowMs }: { row: HotSpotRow; nowMs: number }) {
  const buckets = useMemo(() => hotSpotSparkline(row, nowMs), [row, nowMs]);
  const max = Math.max(...buckets, 1);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 14, marginLeft: "auto" }}>
      {buckets.map((v, i) => (
        <View
          key={i}
          style={{
            width: 3,
            borderRadius: 1,
            height: Math.max(Math.round((v / max) * 14), 2),
            backgroundColor: SPARK,
          }}
        />
      ))}
    </View>
  );
}

function BandHeader({ label, color, pad }: { label: string; color: string; pad: number }) {
  return (
    <View
      style={{
        paddingHorizontal: pad,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: HAIRLINE,
        backgroundColor: "rgba(9,27,84,0.03)",
      }}
    >
      <Text style={{ fontSize: 10.5, fontWeight: "800", letterSpacing: 0.9, color }}>{label}</Text>
    </View>
  );
}

const RANK_W = 20;
const RANK_GAP = 8;

/** One ranked unit: rank · unit · classification · risk meter · map pin, then
 *  the signal-chips line with the sparkline right-aligned. */
function RankRow({
  row,
  rank,
  selected,
  highlightSelection,
  nowMs,
  pad,
  onPress,
  onShowOnMap,
}: {
  row: HotSpotRow;
  rank: number;
  selected: boolean;
  highlightSelection: boolean;
  nowMs: number;
  pad: number;
  onPress: () => void;
  onShowOnMap: () => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const high = row.riskLevel === "High";
  const topTrade = hotSpotTopTrade(row);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        paddingHorizontal: pad,
        paddingVertical: 10,
        gap: 7,
        borderTopWidth: 1,
        borderTopColor: HAIRLINE_SOFT,
        backgroundColor:
          highlightSelection && selected ? `${palette.fill}1A` : high ? HIGH_ROW_WASH : undefined,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: RANK_GAP }}>
        <Text
          className="text-muted dark:text-white/50"
          style={{ width: RANK_W, fontSize: 11.5, fontWeight: "700", fontVariant: ["tabular-nums"] }}
        >
          {rank}
        </Text>
        <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "800" }}>
          {row.unitNumber}
        </Text>
        {row.classification && row.classification !== "—" ? (
          <Text
            className="text-muted dark:text-white/50"
            numberOfLines={1}
            style={{ flexShrink: 1, fontSize: 10.5 }}
          >
            {row.classification}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        <RiskMeter score={row.score} high={high} />
        <Pressable
          onPress={onShowOnMap}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("hotSpots.showOnMapA11y", { unit: row.unitNumber })}
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(9,27,84,0.06)",
          }}
        >
          <Ionicons name="location-outline" size={14} color="#4C556F" />
        </Pressable>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 5,
          paddingLeft: RANK_W + RANK_GAP,
        }}
      >
        {row.callbackCount > 0 ? (
          <SignalChip label={t("hotSpots.chips.callbacks", { count: row.callbackCount })} color={CALLBACK_CHIP} />
        ) : null}
        {topTrade ? (
          <SignalChip
            label={t("hotSpots.chips.topTrade", { tag: topTrade.tag, count: topTrade.count })}
            color={AMBER}
          />
        ) : null}
        {row.openCount > 0 ? (
          <SignalChip label={t("hotSpots.chips.open", { count: row.openCount })} color={OPEN_CHIP} />
        ) : null}
        {row.oldestOpenDays !== null ? (
          <SignalChip label={t("hotSpots.chips.oldest", { count: row.oldestOpenDays })} color={MUTED} />
        ) : null}
        <Sparkline row={row} nowMs={nowMs} />
      </View>
    </Pressable>
  );
}

function HotSpotList({
  rows,
  selectedUnit,
  onSelectUnit,
  onShowOnMap,
  highlightSelection,
  nowMs,
  pad,
}: {
  rows: HotSpotRow[];
  selectedUnit: string | null;
  onSelectUnit: (u: string | null) => void;
  onShowOnMap: (unit: string) => void;
  highlightSelection: boolean;
  nowMs: number;
  pad: number;
}) {
  const { t } = useTranslation();
  const high = rows.filter((r) => r.riskLevel === "High");
  const watch = rows.filter((r) => r.riskLevel !== "High");
  // Overall rank across the full ranked list, continuing through both bands.
  const rankOf = new Map(rows.map((r, i) => [r.unitNumber, i + 1]));

  const renderRow = (row: HotSpotRow) => {
    const selected = row.unitNumber === selectedUnit;
    return (
      <RankRow
        key={row.unitNumber}
        row={row}
        rank={rankOf.get(row.unitNumber) ?? 0}
        selected={selected}
        highlightSelection={highlightSelection}
        nowMs={nowMs}
        pad={pad}
        onPress={() => onSelectUnit(selected ? null : row.unitNumber)}
        onShowOnMap={() => onShowOnMap(row.unitNumber)}
      />
    );
  };

  return (
    <View>
      {high.length > 0 ? (
        <BandHeader label={t("hotSpots.bandHigh", { count: high.length })} color={HIGH_BAND_LABEL} pad={pad} />
      ) : null}
      {high.map(renderRow)}
      {watch.length > 0 ? (
        <BandHeader label={t("hotSpots.bandWatch", { count: watch.length })} color="#4C556F" pad={pad} />
      ) : null}
      {watch.map(renderRow)}
    </View>
  );
}

// ── Detail pane ─────────────────────────────────────────────────────────────

/** Big score over a tiny uppercase risk label, tinted by risk level. */
function RiskBadge({ score, riskLevel }: { score: number; riskLevel: HotSpotRow["riskLevel"] }) {
  const tint = RISK_TINTS[riskLevel];
  return (
    <View
      style={{
        borderRadius: 13,
        paddingHorizontal: 9,
        paddingVertical: 4,
        alignItems: "center",
        backgroundColor: tint.bg,
      }}
    >
      <Text style={{ fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"], color: tint.fg }}>
        {score}
      </Text>
      <Text style={{ fontSize: 7.8, fontWeight: "700", letterSpacing: 0.6, color: tint.fg }}>
        {riskLevel.toUpperCase()}
      </Text>
    </View>
  );
}

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View
      style={{
        flexBasis: "30%",
        flexGrow: 1,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: HAIRLINE,
        backgroundColor: "rgba(255,255,255,0.55)",
        padding: 8,
      }}
    >
      <Text
        className="text-muted dark:text-white/50"
        numberOfLines={1}
        style={{ fontSize: 9, fontWeight: "700", letterSpacing: 0.5 }}
      >
        {label.toUpperCase()}
      </Text>
      <Text
        className={color ? "" : "text-navy dark:text-white"}
        style={{ fontSize: 14, fontWeight: "700", marginTop: 3, fontVariant: ["tabular-nums"], color }}
      >
        {value}
      </Text>
    </View>
  );
}

function DetailPane({ row, nowMs }: { row: HotSpotRow; nowMs: number }) {
  const { t } = useTranslation();
  const shown = row.detail.slice(0, DETAIL_CAP);
  const overflow = row.detail.length - shown.length;
  return (
    <AppCardSurface kind="panel" style={{ overflow: "hidden" }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
            {row.unitNumber}
          </Text>
          <ClassificationChip classification={row.classification} />
          <View style={{ flex: 1 }} />
          <RiskBadge score={row.score} riskLevel={row.riskLevel} />
        </View>
        <Text className="text-muted dark:text-white/60" style={{ fontSize: 11, marginTop: 2 }}>
          {row.occupiedDaysText ?? row.sinceLabel}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          <MetricCell label={t("hotSpots.detail.totalTickets")} value={String(row.totalCount)} />
          <MetricCell label={t("hotSpots.detail.last90")} value={String(row.recentCount)} />
          <MetricCell
            label={t("hotSpots.detail.openNow")}
            value={String(row.openCount)}
            color={row.openCount > 0 ? RED : undefined}
          />
          <MetricCell
            label={t("hotSpots.detail.callbacks")}
            value={String(row.callbackCount)}
            color={row.callbackCount > 0 ? CALLBACK_TINT : undefined}
          />
          <MetricCell
            label={t("hotSpots.detail.duplicates")}
            value={String(row.duplicateCount)}
            color={row.duplicateCount > 0 ? OPEN_CHIP : undefined}
          />
          <MetricCell
            label={t("hotSpots.detail.oldestOpen")}
            value={row.oldestOpenDays !== null ? `${row.oldestOpenDays}d` : "—"}
          />
        </View>
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 8.5, fontWeight: "700", letterSpacing: 0.7, marginTop: 14 }}
        >
          {t("hotSpots.detail.workOrders90").toUpperCase()}
        </Text>
      </View>
      <ColumnHeader
        labels={[
          t("hotSpots.detail.columns.id"),
          t("hotSpots.detail.columns.status"),
          t("hotSpots.detail.columns.technician"),
          t("hotSpots.detail.columns.reported"),
        ]}
      />
      {shown.map((wo) => (
        <WorkOrderRow
          key={wo.id}
          number={wo.number}
          status={wo.status}
          title={wo.title}
          signal={rowSignal(wo)}
          middle={
            <Text className="text-muted dark:text-white/60" numberOfLines={1} style={{ fontSize: 10.5 }}>
              {wo.technicianDisplay}
            </Text>
          }
          trailing={abbreviatedDate(wo.reportedAt ?? wo.completedAt, nowMs)}
        />
      ))}
      {overflow > 0 ? (
        <View style={{ borderTopWidth: 1, borderTopColor: HAIRLINE_SOFT, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Text className="text-muted dark:text-white/50" style={{ fontSize: 10.5 }}>
            {t("hotSpots.detail.more", { count: overflow })}
          </Text>
        </View>
      ) : null}
    </AppCardSurface>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export function HotSpots({
  rows,
  selectedUnit,
  onSelectUnit,
  nowMs,
  width,
  pad,
}: {
  rows: HotSpotRow[];
  selectedUnit: string | null;
  onSelectUnit: (u: string | null) => void;
  nowMs: number;
  width: number;
  /** Screen edge inset the full-bleed rows use for their content. */
  pad: number;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const tablet = width >= 768;

  // Same jump pattern as the work-order detail screen's "show on map".
  const showOnMap = (unitNumber: string) => {
    const unit = unitNumber.trim();
    if (unit.length > 0) {
      capture("show_on_map_used");
      useMapJump.getState().request(unit);
    }
    router.push("/(tabs)/property-map");
  };

  if (rows.length === 0) {
    return (
      <View style={{ paddingHorizontal: pad }}>
        <AppCardSurface kind="panel" style={{ paddingVertical: 30, paddingHorizontal: 20, alignItems: "center" }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "700" }}>
            {t("hotSpots.emptyTitle")}
          </Text>
          <Text
            className="text-muted dark:text-white/60"
            style={{ fontSize: 11, marginTop: 4, textAlign: "center" }}
          >
            {t("hotSpots.emptyBody")}
          </Text>
        </AppCardSurface>
      </View>
    );
  }

  const selectedRow =
    selectedUnit !== null ? (rows.find((r) => r.unitNumber === selectedUnit) ?? null) : null;

  if (!tablet) {
    if (selectedRow) {
      return (
        <View style={{ paddingHorizontal: pad }}>
          <Pressable
            onPress={() => onSelectUnit(null)}
            accessibilityRole="button"
            hitSlop={8}
            style={{ alignSelf: "flex-start", marginBottom: 8 }}
          >
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: "#4C556F" }}>
              ‹  {t("hotSpots.allHotSpots")}
            </Text>
          </Pressable>
          <DetailPane row={selectedRow} nowMs={nowMs} />
        </View>
      );
    }
    return (
      <View>
        <TrendStrip rows={rows} nowMs={nowMs} pad={pad} />
        <HotSpotList
          rows={rows}
          selectedUnit={selectedUnit}
          onSelectUnit={onSelectUnit}
          onShowOnMap={showOnMap}
          highlightSelection={false}
          nowMs={nowMs}
          pad={pad}
        />
      </View>
    );
  }

  // Tablet: side-by-side, defaulting to the top-ranked unit.
  const detailRow = selectedRow ?? rows[0];
  return (
    <View>
      <TrendStrip rows={rows} nowMs={nowMs} pad={pad} />
      <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start", paddingHorizontal: pad }}>
        <View style={{ width: 372 }}>
          <AppCardSurface kind="panel" style={{ overflow: "hidden" }}>
            <HotSpotList
              rows={rows}
              selectedUnit={detailRow.unitNumber}
              onSelectUnit={onSelectUnit}
              onShowOnMap={showOnMap}
              highlightSelection
              nowMs={nowMs}
              pad={14}
            />
          </AppCardSurface>
        </View>
        <View style={{ flex: 1 }}>
          <DetailPane row={detailRow} nowMs={nowMs} />
        </View>
      </View>
    </View>
  );
}

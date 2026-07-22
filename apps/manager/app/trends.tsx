import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  DeltaText,
  LegendNote,
  LegendSwatch,
  RangeChip,
  SheetFooter,
  TREND_COLORS,
  TrendCard,
} from "@/components/trends/bits";
import { StackedAging, AGING_LEGEND_COLORS, type AgingPoint } from "@/components/trends/StackedAging";
import { TrendLine } from "@/components/trends/TrendLine";
import { capture } from "@/lib/analytics";
import type { Snapshot } from "@/lib/api/snapshots";
import {
  rangeDelta,
  seriesBeganDate,
  seriesOf,
  sliceRange,
  trendMoney,
  yoyDelta,
  type TrendRange,
} from "@/lib/derived/trends";
import { activeLocale } from "@/lib/i18n";
import { useConfig } from "@/lib/stores/config";
import { useSnapshots } from "@/lib/stores/snapshots";

/**
 * Trends — every KPI gets a history (mockup: "Trends sheet · tapped from a
 * KPI"). A MODAL route, not a tab, mirroring app/people.tsx: the sheet opens
 * over whatever board you were on and hands you back. Range chips slice the
 * cached 24-month snapshot window locally; the three chart cards are exactly
 * the mockup's: Occupancy (line, YoY chip, lease-span-backfill caption),
 * Delinquency by age (stacked areas + honest series-start caption), Rent
 * roll (line). One snapshot row per day; the charts read the table directly.
 */

const RANGE_LABEL_KEYS: Record<TrendRange, string> = {
  "12m": "trends.ranges.twelveMonths",
  "3m": "trends.ranges.threeMonths",
  "30d": "trends.ranges.thirtyDays",
};

/** "Jul 22" in the active locale, from "YYYY-MM-DD". */
function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(activeLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Aug" in the active locale, from "YYYY-MM-DD". */
function shortMonth(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(activeLocale(), {
    month: "short",
    timeZone: "UTC",
  });
}

const pickOccupancy = (s: Snapshot) => s.occupancyPct;
const pickBalanceTotal = (s: Snapshot) => s.balanceTotal;
const pickRentRoll = (s: Snapshot) => s.rentRoll;

export default function TrendsScreen() {
  const router = useRouter();
  const { t } = useTranslation();

  const baseUrl = useConfig((s) => s.baseUrl);
  const token = useConfig((s) => s.token);
  const config = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);

  const snapshots = useSnapshots((s) => s.snapshots);
  const loading = useSnapshots((s) => s.loading);
  const refreshedAt = useSnapshots((s) => s.refreshedAt);
  const loadAll = useSnapshots((s) => s.loadAll);

  // A cold open (deep link, killed app) must not show an empty sheet just
  // because the 60s tick hasn't run yet.
  useEffect(() => {
    if (snapshots.length === 0) void loadAll(config);
  }, [snapshots.length, loadAll, config]);

  const [range, setRange] = useState<TrendRange>("12m");

  // One event on open, one per range change — the range rides along.
  useEffect(() => {
    capture("trends_opened", { range });
  }, [range]);

  // "Now" for window math: the last sync's timestamp, falling back to mount
  // time — keeping Date.now() out of the render body (people.tsx pattern).
  const [mountedAt] = useState(() => Date.now());
  const nowMs = refreshedAt > 0 ? refreshedAt : mountedAt;

  const windowed = useMemo(() => sliceRange(snapshots, range, nowMs), [snapshots, range, nowMs]);

  // ── Occupancy ─────────────────────────────────────────────────────────────
  const occupancyPoints = useMemo(() => seriesOf(windowed, pickOccupancy), [windowed]);
  const occupancyYoy = useMemo(() => yoyDelta(snapshots, pickOccupancy), [snapshots]);
  const occupancyLast =
    occupancyPoints.length > 0 ? occupancyPoints[occupancyPoints.length - 1].value : null;

  // ── Delinquency by age ────────────────────────────────────────────────────
  const agingPoints = useMemo<AgingPoint[]>(
    () =>
      windowed
        .filter((s) => s.balanceTotal !== null)
        .map((s) => ({
          b0030: s.balance0To30 ?? 0,
          b3190: (s.balance31To60 ?? 0) + (s.balance61To90 ?? 0),
          b90: s.balance90Plus ?? 0,
        })),
    [windowed],
  );
  const balancePoints = useMemo(() => seriesOf(windowed, pickBalanceTotal), [windowed]);
  const balanceMove = useMemo(() => rangeDelta(balancePoints), [balancePoints]);
  // The honest caption: the first day the balance series has a real value.
  const balanceBegan = useMemo(() => seriesBeganDate(snapshots, pickBalanceTotal), [snapshots]);

  // ── Rent roll ─────────────────────────────────────────────────────────────
  const rentRollPoints = useMemo(() => seriesOf(windowed, pickRentRoll), [windowed]);
  const rentRollLast =
    rentRollPoints.length > 0 ? rentRollPoints[rentRollPoints.length - 1].value : null;
  const rentRollYoyAbs = useMemo(() => yoyDelta(snapshots, pickRentRoll), [snapshots]);
  const rentRollYoyPct = useMemo(() => {
    if (rentRollYoyAbs === null || rentRollLast === null) return null;
    const prior = rentRollLast - rentRollYoyAbs;
    return prior > 0 ? (rentRollYoyAbs / prior) * 100 : null;
  }, [rentRollYoyAbs, rentRollLast]);

  const showSpinner = loading && snapshots.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: "rgba(250,247,240,0.98)" }}>
      {/* Sheet chrome: grabber, title, close — the mockup's `.sheet` head. */}
      <View
        style={{
          alignSelf: "center",
          width: 36,
          height: 4,
          borderRadius: 2,
          backgroundColor: "rgba(9,27,84,0.15)",
          marginTop: 8,
        }}
      />
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingTop: 12 }}
      >
        <Text
          style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: TREND_COLORS.navy }}
        >
          {t("trends.title")}
        </Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t("trends.close")}
          hitSlop={8}
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            backgroundColor: "rgba(9,27,84,0.06)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="close" size={14} color={TREND_COLORS.slate} />
        </Pressable>
      </View>

      {/* Range chips: 12 months / 3 months / 30 days. */}
      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 18, paddingTop: 10 }}>
        {(Object.keys(RANGE_LABEL_KEYS) as TrendRange[]).map((key) => (
          <RangeChip
            key={key}
            label={t(RANGE_LABEL_KEYS[key])}
            active={range === key}
            onPress={() => setRange(key)}
          />
        ))}
      </View>

      {showSpinner ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      ) : snapshots.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
          <Text style={{ fontSize: 11.5, color: TREND_COLORS.muted, textAlign: "center" }}>
            {t("trends.empty.sheet")}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}>
          {/* ── Occupancy ── */}
          <TrendCard
            title={t("trends.occupancy.title")}
            right={
              occupancyLast !== null && occupancyYoy !== null ? (
                <DeltaText
                  delta={occupancyYoy}
                  upIsGood
                  prefix={`${occupancyLast.toFixed(1)}% · `}
                  format={(abs) => t("trends.occupancy.yoyDelta", { points: abs.toFixed(1) })}
                />
              ) : occupancyLast !== null ? (
                <Text style={{ fontSize: 9, fontWeight: "800", color: TREND_COLORS.pos }}>
                  {`${occupancyLast.toFixed(1)}%`}
                </Text>
              ) : undefined
            }
          >
            <TrendLine
              points={occupancyPoints.map((p) => p.value)}
              tint={TREND_COLORS.pos}
              emptyLabel={t("trends.empty.chart")}
            />
            <LegendNote>
              {occupancyPoints.length >= 2
                ? t("trends.occupancy.legend", {
                    from: shortMonth(occupancyPoints[0].date),
                    to: shortMonth(occupancyPoints[occupancyPoints.length - 1].date),
                  })
                : t("trends.occupancy.legendNoRange")}
            </LegendNote>
          </TrendCard>

          {/* ── Delinquency by age ── */}
          <TrendCard
            title={t("trends.delinquency.title")}
            right={
              balanceMove !== null ? (
                <DeltaText
                  delta={balanceMove.delta}
                  upIsGood={false}
                  prefix={`${trendMoney(balanceMove.last)} · `}
                  format={(abs) => trendMoney(abs)}
                />
              ) : undefined
            }
          >
            <StackedAging points={agingPoints} emptyLabel={t("trends.empty.chart")} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 5 }}>
              <LegendSwatch color={AGING_LEGEND_COLORS.b0030} label={t("trends.delinquency.buckets.b0030")} />
              <LegendSwatch color={AGING_LEGEND_COLORS.b3190} label={t("trends.delinquency.buckets.b3190")} />
              <LegendSwatch color={AGING_LEGEND_COLORS.b90} label={t("trends.delinquency.buckets.b90")} />
              <View style={{ flex: 1 }} />
              {balanceBegan ? (
                <Text style={{ fontSize: 8.5, fontWeight: "600", color: TREND_COLORS.muted }}>
                  {t("trends.delinquency.seriesBegan", { date: shortDay(balanceBegan) })}
                </Text>
              ) : null}
            </View>
          </TrendCard>

          {/* ── Rent roll ── */}
          <TrendCard
            title={t("trends.rentRoll.title")}
            right={
              rentRollLast !== null && rentRollYoyPct !== null ? (
                <DeltaText
                  delta={rentRollYoyPct}
                  upIsGood
                  prefix={`${trendMoney(rentRollLast)} · `}
                  format={(abs) => t("trends.rentRoll.yoyDelta", { percent: abs.toFixed(1) })}
                />
              ) : rentRollLast !== null ? (
                <Text style={{ fontSize: 9, fontWeight: "800", color: TREND_COLORS.purple }}>
                  {trendMoney(rentRollLast)}
                </Text>
              ) : undefined
            }
          >
            <TrendLine
              points={rentRollPoints.map((p) => p.value)}
              tint={TREND_COLORS.purple}
              emptyLabel={t("trends.empty.chart")}
            />
          </TrendCard>

          <SheetFooter>{t("trends.footer")}</SheetFooter>
        </ScrollView>
      )}
    </View>
  );
}

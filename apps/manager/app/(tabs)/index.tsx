import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ExpiringSoonCard,
  FlowCard,
  FlowChartCard,
  LinkedFeatureCard,
  MakeReadyCard,
  RunwayCard,
  UtilitiesCard,
  type RunwaySummary,
  type UtilitiesDueSummary,
} from "@/components/today/cards";
import { BoardHeader, type BoardMetric } from "@/components/ui/BoardHeader";
import { capture } from "@/lib/analytics";
import {
  buildExpirationRows,
  buildMonthlyFlow,
  buildPipelineRows,
  buildTodayFeed,
  buildTodayMetrics,
  unitFactsIndex,
  unitFactsOf,
} from "@/lib/derived/leasing";
import {
  buildUtilitySummary,
  computeUtilityExceptions,
  type ExceptionCopy,
} from "@/lib/derived/utility-exceptions";
import { buildWorkData, makeReadySnapshot } from "@/lib/derived/work-boards";
import { activeLocale } from "@/lib/i18n";
import { useLeases } from "@/lib/stores/leases";
import { useMlgw } from "@/lib/stores/mlgw";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { MUTED, screenHPad } from "@/theme/tokens";

// The Today cards only need the exception COUNTS; display copy is never
// rendered here, so the derivation runs with inert strings rather than
// duplicating the Utilities screen's full i18n seam.
const COUNT_ONLY_COPY: ExceptionCopy = {
  title: () => "",
  action: () => "",
  detail: () => "",
};

// Evaluated once per app launch (module scope keeps render pure), matching the
// Utilities screen's day-granularity convention.
const TODAY_ISO = new Date().toISOString().slice(0, 10);

/**
 * Today — the manager's morning board (mockup: "Today — the manager's day").
 * KPI strip in the glass header (occupancy · balances owed · move-ins 30d ·
 * expiring 60d), then the flow feed, the move-in/move-out chart, and the
 * leasing runway. iPad (width ≥ 1040) lays the cards out as the three-column
 * workspace. Everything derives from the synced mirrors on device; the
 * cross-feature cards (make ready from the work-order mirror, utilities due
 * from the MLGW mirror) read their stores read-only and hide until data
 * exists (LinkedFeatureCard).
 */
export default function TodayScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pad = screenHPad(width);
  const wide = width >= 1040;
  const [headerH, setHeaderH] = useState(insets.top + 150);

  const leases = useLeases((s) => s.leases);
  const allUnits = useUnits((s) => s.allUnits);
  const workOrders = useWorkOrders((s) => s.workOrders);
  const mlgwData = useMlgw((s) => s.data);

  // "Now" is state, refreshed whenever the tab regains focus — calendar math
  // stays render-pure and still tracks the day across a long-lived session.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNowMs(Date.now());
    }, []),
  );

  const unitsIdx = useMemo(() => unitFactsIndex(allUnits), [allUnits]);
  const unitFactsList = useMemo(() => allUnits.map(unitFactsOf), [allUnits]);

  const feed = useMemo(
    () => buildTodayFeed(leases, unitsIdx, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases, unitsIdx],
  );
  const flow = useMemo(
    () => buildMonthlyFlow(leases, nowMs, 6),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases],
  );
  const expirationRows = useMemo(
    () => buildExpirationRows(leases, unitsIdx, nowMs, 90),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases, unitsIdx],
  );
  const pipelineRows = useMemo(
    () => buildPipelineRows(leases, unitsIdx, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases, unitsIdx],
  );

  const openCard = (card: string, path?: Parameters<typeof router.push>[0]) => {
    capture("today_card_opened", { card });
    if (path) router.push(path);
  };

  const metrics: BoardMetric[] = useMemo(() => {
    const raw = buildTodayMetrics({ units: unitFactsList, leases, expirationRows90: expirationRows, nowMs });
    const target: Record<string, Parameters<typeof router.push>[0]> = {
      occupancy: "/(tabs)/property-map",
      balances: "/(tabs)/delinquency",
      moveIns30: "/(tabs)/leasing",
      expiring60: "/(tabs)/leasing",
    };
    return raw.map((m) => ({
      value: m.value,
      tint: m.tint,
      label: t(m.labelKey),
      caption: m.captionKey ? t(m.captionKey, m.captionParams) : undefined,
      onPress: () => openCard(`metric:${m.key}`, target[m.key]),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitFactsList, leases, expirationRows, t]);

  const runway: RunwaySummary = useMemo(() => {
    const in60 = expirationRows.filter((r) => r.daysLeft <= 60);
    const notRenewed = in60.filter((r) => r.state !== "renewed");
    return {
      expiringCount: in60.length,
      atRisk: notRenewed.reduce((sum, r) => sum + (r.lease.residentRent ?? 0), 0),
      markToMarket: in60.reduce((sum, r) => sum + (r.markToMarket ?? 0), 0),
      renewed: in60.filter((r) => r.state === "renewed").length,
      noResponse: in60.filter((r) => r.state === "open").length,
      applicants: pipelineRows.length,
      approved: pipelineRows.filter((r) => r.stage === "approved").length,
      screening: pipelineRows.filter((r) => r.stage === "screening").length,
      leaseSent: pipelineRows.filter((r) => r.stage === "leaseSent").length,
    };
  }, [expirationRows, pipelineRows]);

  const flowCard = (
    <FlowCard
      events={feed}
      nowMs={nowMs}
      limit={wide ? 9 : 6}
      onGo={() => openCard("flow", "/(tabs)/leasing")}
    />
  );
  const chartCard = <FlowChartCard flow={flow} />;
  const runwayCard = <RunwayCard summary={runway} onGo={() => openCard("runway", "/(tabs)/leasing")} />;
  const expiringSoonCard = <ExpiringSoonCard rows={expirationRows.filter((r) => r.daysLeft <= 45)} />;

  // Cross-feature cards, read-only: the make-ready line from the shared
  // work-order engine and the utilities-due line from the MLGW mirror. Both
  // keep LinkedFeatureCard's hide-when-no-data behavior — a cold cache (or a
  // property with no turns) renders nothing rather than a row of zeros.
  const makeReady = useMemo(
    () =>
      workOrders.length === 0 ? null : makeReadySnapshot(buildWorkData(workOrders, allUnits), nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workOrders, allUnits],
  );
  const utilities: UtilitiesDueSummary | null = useMemo(() => {
    if (mlgwData === null) return null;
    const exceptions = computeUtilityExceptions(
      {
        ...mlgwData,
        units: allUnits.map((u) => ({ unitNumber: u.number, moveInDate: u.move_in_date })),
        nowIso: TODAY_ISO,
      },
      COUNT_ONLY_COPY,
    );
    const s = buildUtilitySummary(mlgwData.accounts, mlgwData.currentBills, exceptions, TODAY_ISO);
    return { due: s.currentDue, billCount: s.currentBillCount, spikeCount: s.spikeCount };
  }, [mlgwData, allUnits]);

  const makeReadyCard = (
    <LinkedFeatureCard
      data={makeReady}
      render={(snapshot) => (
        <MakeReadyCard
          snapshot={snapshot}
          onGo={() =>
            openCard("makeReady", { pathname: "/(tabs)/work", params: { mode: "makeReady" } })
          }
        />
      )}
    />
  );
  const utilitiesCard = (
    <LinkedFeatureCard
      data={utilities}
      render={(summary) => (
        <UtilitiesCard summary={summary} onGo={() => openCard("utilities", "/(tabs)/utilities")} />
      )}
    />
  );

  const headerTrailing = wide ? (
    <Text style={{ fontSize: 11, color: MUTED, marginRight: 6 }}>
      {new Date(nowMs).toLocaleDateString(activeLocale(), {
        weekday: "long",
        month: "long",
        day: "numeric",
      })}
    </Text>
  ) : undefined;

  return (
    <View style={{ flex: 1 }}>
      <BoardHeader
        modes={[{ key: "today", label: t("today.title"), icon: "sunny-outline" }]}
        activeMode="today"
        onMode={() => {}}
        metrics={metrics}
        trailing={headerTrailing}
        onHeight={setHeaderH}
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: headerH + 14,
          paddingHorizontal: pad,
          paddingBottom: insets.bottom + 110,
        }}
      >
        {wide ? (
          // iPad: the three-column workspace (flow · trends · runway).
          <View style={{ flexDirection: "row", gap: 18, alignItems: "flex-start" }}>
            <View style={{ flex: 1, gap: 14 }}>{flowCard}</View>
            <View style={{ flex: 1, gap: 14 }}>
              {chartCard}
              {makeReadyCard}
              {utilitiesCard}
            </View>
            <View style={{ flex: 1, gap: 14 }}>
              {runwayCard}
              {expiringSoonCard}
            </View>
          </View>
        ) : (
          // iPhone: the stacked variant.
          <View style={{ gap: 14 }}>
            {flowCard}
            {makeReadyCard}
            {chartCard}
            {runwayCard}
            {utilitiesCard}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

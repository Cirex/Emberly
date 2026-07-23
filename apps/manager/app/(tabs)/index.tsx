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
  TopBalancesCard,
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
import { PastReports } from "@/components/reports/PastReports";
import { ReportCard } from "@/components/reports/ReportCard";
import { Spark } from "@/components/trends/Spark";
import { latestReport, pastReports } from "@/lib/derived/reports";
import { buildOpenBoard, buildWorkData, makeReadySnapshot } from "@/lib/derived/work-boards";
import { sparkValues } from "@/lib/derived/trends";
import { activeLocale } from "@/lib/i18n";
import { useLeases } from "@/lib/stores/leases";
import { useMlgw } from "@/lib/stores/mlgw";
import { useReports } from "@/lib/stores/reports";
import { useSnapshots } from "@/lib/stores/snapshots";
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
  const snapshots = useSnapshots((s) => s.snapshots);
  const reports = useReports((s) => s.reports);

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

  // Shared work + utility derivations — the KPI band, the make-ready card, and
  // the utilities card all read these, so they're computed once here.
  const workData = useMemo(() => buildWorkData(workOrders, allUnits), [workOrders, allUnits]);
  const makeReady = useMemo(
    () => (workOrders.length === 0 ? null : makeReadySnapshot(workData, nowMs)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workData, workOrders.length],
  );
  const openBoard = useMemo(
    () => (workOrders.length === 0 ? null : buildOpenBoard(workData, nowMs)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workData, workOrders.length],
  );
  const utilityExceptions = useMemo(() => {
    if (mlgwData === null) return null;
    return computeUtilityExceptions(
      {
        ...mlgwData,
        units: allUnits.map((u) => ({ unitNumber: u.number, moveInDate: u.move_in_date })),
        nowIso: TODAY_ISO,
      },
      COUNT_ONLY_COPY,
    );
  }, [mlgwData, allUnits]);
  const utilitySummary = useMemo(() => {
    if (mlgwData === null || utilityExceptions === null) return null;
    return buildUtilitySummary(mlgwData.accounts, mlgwData.currentBills, utilityExceptions, TODAY_ISO);
  }, [mlgwData, utilityExceptions]);

  const metrics: BoardMetric[] = useMemo(() => {
    const raw = buildTodayMetrics({
      units: unitFactsList,
      makeReady: makeReady ? { turnsInProgress: makeReady.turnsInProgress, readyUnits: makeReady.readyUnits } : null,
      openWork: openBoard ? { openCount: openBoard.openCount, emergencyCount: openBoard.emergencyCount } : null,
      utilities:
        utilitySummary && utilityExceptions
          ? { ownerDue: utilitySummary.currentDue, exceptions: utilityExceptions.length }
          : null,
    });
    // Each KPI deep-links to its tab; occupancy and utilities also open Trends
    // via their sparklines, so they point there.
    const target: Record<string, Parameters<typeof router.push>[0]> = {
      occupancy: "/trends",
      available: "/(tabs)/leasing",
      delinquent: "/(tabs)/delinquency",
      openWork: "/(tabs)/work",
      utilities: "/(tabs)/utilities",
    };
    // Sparklines only where a trend tells the story (occupancy, utilities),
    // rendered once ≥14 daily snapshots exist (Spark self-gates via sparkValues).
    const sparkPick: Record<string, (s: (typeof snapshots)[number]) => number | null> = {
      occupancy: (s) => s.occupancyPct,
      utilities: (s) => s.utilityDue,
    };
    return raw.map((m) => {
      const pick = sparkPick[m.key];
      const values = pick ? sparkValues(snapshots, pick, nowMs) : null;
      return {
        value: m.value,
        tint: m.tint,
        label: t(m.labelKey),
        caption: m.captionKey ? t(m.captionKey, m.captionParams) : undefined,
        spark: values ? <Spark points={values} tint={m.tint ?? "#33A666"} /> : undefined,
        onPress: () => openCard(`metric:${m.key}`, target[m.key]),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitFactsList, makeReady, openBoard, utilitySummary, utilityExceptions, snapshots, t]);

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

  // Top open balances — the Money headline surfaced on Today. Severity dot by
  // months owed (≥2× market rent → red).
  const topBalances = useMemo(() => {
    const owing = unitFactsList.filter((u) => (u.balance ?? 0) > 0);
    const sorted = [...owing].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
    return {
      owed: owing.reduce((sum, u) => sum + (u.balance ?? 0), 0),
      count: owing.length,
      rows: sorted.slice(0, 4).map((u) => ({
        unitNumber: u.unitNumber,
        tenant: u.tenantNames[0] ?? "",
        balance: u.balance ?? 0,
        tone: (u.marketRent && (u.balance ?? 0) >= u.marketRent * 2 ? "red" : "amber") as "red" | "amber",
      })),
    };
  }, [unitFactsList]);
  const topBalancesCard =
    topBalances.count > 0 ? (
      <TopBalancesCard
        rows={topBalances.rows}
        owed={topBalances.owed}
        count={topBalances.count}
        onGo={() => openCard("topBalances", "/(tabs)/delinquency")}
      />
    ) : null;

  // Cross-feature cards, read-only: the make-ready line from the shared
  // work-order engine and the utilities-due line from the MLGW mirror. Both
  // keep LinkedFeatureCard's hide-when-no-data behavior — a cold cache (or a
  // property with no turns) renders nothing rather than a row of zeros. The
  // make-ready snapshot and utility summary are the shared memos above.
  const utilities: UtilitiesDueSummary | null = useMemo(
    () =>
      utilitySummary === null
        ? null
        : {
            due: utilitySummary.currentDue,
            billCount: utilitySummary.currentBillCount,
            spikeCount: utilitySummary.spikeCount,
          },
    [utilitySummary],
  );

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
  // Owner report: "report ready" card + the past-reports band, both hidden
  // until the worker has generated at least one report (LinkedFeatureCard).
  const reportCard = (
    <LinkedFeatureCard
      data={latestReport(reports)}
      render={(report) => <ReportCard report={report} />}
    />
  );
  const pastReportsBand = (
    <LinkedFeatureCard
      data={reports.length > 1 ? pastReports(reports) : null}
      render={(past) => <PastReports reports={past} />}
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
          // iPad (mockup frame 02): a 3-column dashboard grid. Left — leasing
          // flow + top balances + renewal runway; middle — make-ready + utilities
          // pulse + expirations; right rail — the activity ticker with the owner
          // report pinned beneath it.
          <View style={{ flexDirection: "row", gap: 18, alignItems: "flex-start" }}>
            <View style={{ flex: 1, gap: 14 }}>
              {chartCard}
              {topBalancesCard}
              {runwayCard}
            </View>
            <View style={{ flex: 1, gap: 14 }}>
              {makeReadyCard}
              {utilitiesCard}
              {expiringSoonCard}
            </View>
            <View style={{ flex: 1, gap: 14 }}>
              {flowCard}
              {reportCard}
              {pastReportsBand}
            </View>
          </View>
        ) : (
          // iPhone: the stacked variant.
          <View style={{ gap: 14 }}>
            {reportCard}
            {chartCard}
            {topBalancesCard}
            {makeReadyCard}
            {utilitiesCard}
            {flowCard}
            {runwayCard}
            {expiringSoonCard}
            {pastReportsBand}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

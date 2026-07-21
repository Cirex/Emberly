import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BarColumns } from "@/components/leasing/BarColumns";
import { BandHeader, QuickChips, type QuickChip } from "@/components/leasing/primitives";
import {
  ExpirationRowView,
  ForecastTable,
  PipelineRowView,
  VacancyRowView,
} from "@/components/leasing/rows";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { BoardHeader, type BoardMetric } from "@/components/ui/BoardHeader";
import { capture } from "@/lib/analytics";
import {
  buildExpirationRows,
  buildForecastRows,
  buildLeasingMetrics,
  buildPipelineRows,
  buildVacancyRows,
  expiringByMonth,
  unitFactsOf,
  unitFactsIndex,
  type ExpirationRow,
  type LeasingMode,
  type PipelineRow,
  type PipelineStage,
  type ScoreMetric,
} from "@/lib/derived/leasing";
import { activeLocale } from "@/lib/i18n";
import { useLeases } from "@/lib/stores/leases";
import { useUnits } from "@/lib/stores/units";
import { screenHPad } from "@/theme/tokens";

/**
 * Leasing — the Work Orders anatomy applied to the funnel: ONE screen, a mode
 * dropdown (Pipeline · Expirations · Forecast · Vacancy), a mode-specific
 * score strip, quick-filter chips with live counts, and banded lists. All
 * board math is lib/derived/leasing.ts; this file only renders.
 */

/** Chips filter within a mode; "all" is every mode's default. */
type ChipKey = string;

export default function LeasingScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pad = screenHPad(width);
  const wide = width >= 1040;

  const [mode, setMode] = useState<LeasingMode>("pipeline");
  const [chip, setChip] = useState<ChipKey>("all");
  const [headerH, setHeaderH] = useState(insets.top + 150);

  const leases = useLeases((s) => s.leases);
  const loading = useLeases((s) => s.loading);
  const error = useLeases((s) => s.error);
  const allUnits = useUnits((s) => s.allUnits);

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

  const pipelineRows = useMemo(
    () => buildPipelineRows(leases, unitsIdx, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases, unitsIdx],
  );
  const expirationRows = useMemo(
    () => buildExpirationRows(leases, unitsIdx, nowMs, 90),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases, unitsIdx],
  );
  const forecastRows = useMemo(
    () => buildForecastRows(leases, unitFactsList, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases, unitFactsList],
  );
  const vacancyRows = useMemo(() => buildVacancyRows(unitFactsList), [unitFactsList]);
  const monthBuckets = useMemo(
    () => expiringByMonth(leases, nowMs, 12),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases],
  );

  const metrics: BoardMetric[] = useMemo(() => {
    const raw = buildLeasingMetrics({
      mode, pipelineRows, expirationRows90: expirationRows, forecastRows, vacancyRows, leases, nowMs,
    });
    return raw.map((m: ScoreMetric) => ({
      value: m.value,
      tint: m.tint,
      label: t(m.labelKey),
      caption: m.captionKey ? t(m.captionKey, m.captionParams) : undefined,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pipelineRows, expirationRows, forecastRows, vacancyRows, leases, t]);

  const modeCounts: Record<LeasingMode, number> = {
    pipeline: pipelineRows.length,
    expirations: expirationRows.length,
    forecast: forecastRows.length,
    vacancy: vacancyRows.length,
  };

  const onMode = (key: string) => {
    const next = key as LeasingMode;
    capture("board_mode_switched", { mode: `leasing:${next}` });
    setMode(next);
    setChip("all");
  };

  // ── Quick chips per mode (live counts) ────────────────────────────────────
  const chips: QuickChip[] = useMemo(() => {
    if (mode === "pipeline") {
      const byStage = (stage: PipelineStage) => pipelineRows.filter((r) => r.stage === stage).length;
      return [
        { key: "all", label: t("leasing.chips.all"), count: pipelineRows.length },
        { key: "screening", label: t("leasing.stages.screening"), count: byStage("screening") },
        { key: "approved", label: t("leasing.stages.approved"), count: byStage("approved") },
        { key: "leaseSent", label: t("leasing.stages.leaseSent"), count: byStage("leaseSent") },
        { key: "signed", label: t("leasing.stages.signed"), count: byStage("signed") },
      ];
    }
    if (mode === "expirations") {
      return [
        { key: "all", label: t("leasing.chips.all"), count: expirationRows.length },
        { key: "d30", label: t("leasing.metrics.next30"), count: expirationRows.filter((r) => r.daysLeft <= 30).length },
        { key: "open", label: t("leasing.row.noResponse"), count: expirationRows.filter((r) => r.state === "open").length },
        { key: "renewed", label: t("leasing.row.renewed"), count: expirationRows.filter((r) => r.state === "renewed").length },
      ];
    }
    if (mode === "vacancy") {
      return [
        { key: "all", label: t("leasing.chips.all"), count: vacancyRows.length },
        { key: "ready", label: t("leasing.row.ready"), count: vacancyRows.filter((r) => r.ready).length },
        { key: "notReady", label: t("leasing.row.notReady"), count: vacancyRows.filter((r) => !r.ready).length },
      ];
    }
    return [];
  }, [mode, pipelineRows, expirationRows, vacancyRows, t]);

  // ── Chip-filtered lists ───────────────────────────────────────────────────
  const visiblePipeline = useMemo(
    () => (chip === "all" ? pipelineRows : pipelineRows.filter((r) => r.stage === chip)),
    [pipelineRows, chip],
  );
  const visibleExpirations = useMemo(() => {
    if (chip === "d30") return expirationRows.filter((r) => r.daysLeft <= 30);
    if (chip === "open") return expirationRows.filter((r) => r.state === "open");
    if (chip === "renewed") return expirationRows.filter((r) => r.state === "renewed");
    return expirationRows;
  }, [expirationRows, chip]);
  const visibleVacancy = useMemo(() => {
    if (chip === "ready") return vacancyRows.filter((r) => r.ready);
    if (chip === "notReady") return vacancyRows.filter((r) => !r.ready);
    return vacancyRows;
  }, [vacancyRows, chip]);

  const statusLine =
    loading || error ? (
      <View style={{ paddingHorizontal: pad, paddingBottom: 8 }}>
        {loading ? (
          <Text className="text-muted" style={{ fontSize: 12, textAlign: "center" }}>
            {t("leasing.loading")}
          </Text>
        ) : null}
        {error ? <Text style={{ color: "#D1382E", fontSize: 12, textAlign: "center" }}>{error}</Text> : null}
      </View>
    ) : null;

  const emptyState = (
    <View style={{ alignItems: "center", paddingVertical: 44, gap: 6, paddingHorizontal: pad }}>
      <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
        {t("leasing.emptyTitle")}
      </Text>
      <Text className="text-muted dark:text-white/60" style={{ fontSize: 12.5, textAlign: "center" }}>
        {t("leasing.emptyBody")}
      </Text>
    </View>
  );

  /** A band label + its rows in one glass panel. Nothing renders for 0 rows. */
  const band = (label: string, hot: boolean, children: React.ReactNode[], key: string) =>
    children.length === 0 ? null : (
      <View key={key}>
        <BandHeader label={label} hot={hot} pad={0} />
        <AppCardSurface kind="panel" style={{ overflow: "hidden" }}>
          {children}
        </AppCardSurface>
      </View>
    );

  // ── Mode bodies ───────────────────────────────────────────────────────────
  const pipelineBody = () => {
    const imminent = visiblePipeline.filter((r) => r.imminent);
    const inFlight = visiblePipeline.filter((r) => !r.imminent);
    const rowViews = (rows: PipelineRow[]) =>
      rows.map((r, i) => <PipelineRowView key={r.lease.id} row={r} last={i === rows.length - 1} />);
    if (visiblePipeline.length === 0) return emptyState;
    return (
      <View style={{ gap: 4 }}>
        {band(t("leasing.bands.moveInThisWeek", { count: imminent.length }), false, rowViews(imminent), "imminent")}
        {band(t("leasing.bands.inFlight", { count: inFlight.length }), false, rowViews(inFlight), "inflight")}
      </View>
    );
  };

  const monthChart = (
    <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "800" }}>
          {t("leasing.chart.expiringByMonth")}
        </Text>
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 10.5 }}>
          {t("leasing.chart.months12")}
        </Text>
      </View>
      <BarColumns
        height={64}
        columns={monthBuckets.map((b, i) => {
          const hot = b.count === Math.max(...monthBuckets.map((x) => x.count)) && b.count > 0;
          return {
            key: String(b.monthMs),
            label: new Date(b.monthMs).toLocaleDateString(activeLocale(), { month: "short" }),
            values: [{ value: b.count, color: hot ? "#D1382E" : "rgba(162,169,33,0.75)" }],
          };
        })}
      />
    </AppCardSurface>
  );

  const expirationsBody = () => {
    const soon = visibleExpirations.filter((r) => r.daysLeft <= 30);
    const later = visibleExpirations.filter((r) => r.daysLeft > 30);
    const rowViews = (rows: ExpirationRow[]) =>
      rows.map((r, i) => <ExpirationRowView key={r.lease.id} row={r} last={i === rows.length - 1} />);
    const list =
      visibleExpirations.length === 0 ? (
        emptyState
      ) : (
        <View style={{ gap: 4 }}>
          {band(t("leasing.bands.expires30", { count: soon.length }), true, rowViews(soon), "soon")}
          {band(t("leasing.bands.expiresLater", { count: later.length }), false, rowViews(later), "later")}
        </View>
      );
    // Wide: chart beside the list; phone: chart stacked on top.
    if (wide) {
      return (
        <View style={{ flexDirection: "row", gap: 18, alignItems: "flex-start" }}>
          <View style={{ width: 360 }}>{monthChart}</View>
          <View style={{ flex: 1 }}>{list}</View>
        </View>
      );
    }
    return (
      <View style={{ gap: 4 }}>
        {monthChart}
        {list}
      </View>
    );
  };

  const forecastBody = () => (
    <View style={{ maxWidth: wide ? 640 : undefined }}>
      <AppCardSurface kind="panel" style={{ overflow: "hidden" }}>
        <ForecastTable rows={forecastRows} />
      </AppCardSurface>
      <Text className="text-muted dark:text-white/50" style={{ fontSize: 10.5, marginTop: 8, textAlign: "center" }}>
        {t("leasing.forecast.caption")}
      </Text>
    </View>
  );

  const vacancyBody = () => {
    const ready = visibleVacancy.filter((r) => r.ready);
    const notReady = visibleVacancy.filter((r) => !r.ready);
    if (visibleVacancy.length === 0) return emptyState;
    return (
      <View style={{ gap: 4 }}>
        {band(
          t("leasing.bands.vacantReady", { count: ready.length }), false,
          ready.map((r, i) => <VacancyRowView key={r.unitNumber} row={r} last={i === ready.length - 1} />),
          "ready",
        )}
        {band(
          t("leasing.bands.vacantNotReady", { count: notReady.length }), true,
          notReady.map((r, i) => <VacancyRowView key={r.unitNumber} row={r} last={i === notReady.length - 1} />),
          "notReady",
        )}
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <BoardHeader
        modes={[
          { key: "pipeline", label: t("leasing.modes.pipeline"), icon: "key-outline", count: modeCounts.pipeline },
          { key: "expirations", label: t("leasing.modes.expirations"), icon: "calendar-outline", count: modeCounts.expirations },
          { key: "forecast", label: t("leasing.modes.forecast"), icon: "trending-up-outline" },
          { key: "vacancy", label: t("leasing.modes.vacancy"), icon: "home-outline", count: modeCounts.vacancy },
        ]}
        activeMode={mode}
        onMode={onMode}
        metrics={metrics}
        onHeight={setHeaderH}
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: headerH + 10,
          paddingBottom: insets.bottom + 110,
        }}
      >
        {statusLine}
        {chips.length > 0 ? (
          <View style={{ marginBottom: 6 }}>
            <QuickChips chips={chips} active={chip} onChip={setChip} pad={pad} />
          </View>
        ) : null}
        <View style={{ paddingHorizontal: pad, maxWidth: wide && mode !== "expirations" ? 860 : undefined }}>
          {mode === "pipeline"
            ? pipelineBody()
            : mode === "expirations"
              ? expirationsBody()
              : mode === "forecast"
                ? forecastBody()
                : vacancyBody()}
        </View>
      </ScrollView>
    </View>
  );
}

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
import {
  NeedsOfferRowView,
  OfferSentRowView,
  ResolvedRowView,
} from "@/components/leasing/renewal-rows";
import {
  CoverageBar,
  ExpiringRowView,
  LapsedRowView,
  NeverFiledRowView,
} from "@/components/leasing/insurance-rows";
import { AgentsBoard } from "@/components/leasing/AgentsBoard";
import { RunwayBoard } from "@/components/leasing/RunwayBoard";
import { InsuranceDetailSheet } from "@/components/leasing/InsuranceDetailSheet";
import { RenewalOfferSheet, type RenewalOfferDraft } from "@/components/leasing/RenewalOfferSheet";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { BoardHeader, type BoardMetric } from "@/components/ui/BoardHeader";
import { capture } from "@/lib/analytics";
import type { InsuranceActionKind } from "@/lib/api/insurance";
import type { RenewalResolutionStatus } from "@/lib/api/renewals";
import {
  buildExpirationRows,
  buildForecastRows,
  buildLeasingMetrics,
  buildPipelineRows,
  buildVacancyRows,
  expiringByMonth,
  isAwaitingSignature,
  PIPELINE_STAGE_ORDER,
  unitFactsOf,
  unitFactsIndex,
  type ExpirationRow,
  type LeasingMode,
  type PipelineRow,
  type PipelineStage,
  type ScoreMetric,
} from "@/lib/derived/leasing";
import { PipelineDetailSheet } from "@/components/leasing/PipelineDetailSheet";
import { buildLeasingAgentBoard, buildLeasingAgentMetrics } from "@/lib/derived/leasing-agents";
import { isClosedWorkOrder } from "@emberly/core";
import { buildMakeReadyBoard, buildWorkData } from "@/lib/derived/work-boards";
import { useWorkOrders } from "@/lib/stores/work-orders";
import {
  actionsByLease,
  buildInsuranceBoard,
  buildInsuranceMetrics,
  buildInsuranceTimeline,
  type InsuranceRowView,
} from "@/lib/derived/insurance-view";
import {
  buildInternalComps,
  buildOfferTimeline,
  buildRenewalMetrics,
  buildRenewalsBoard,
  governingOfferByLease,
  renewalSubject,
} from "@/lib/derived/renewals-view";
import { activeLocale } from "@/lib/i18n";
import { useConfig } from "@/lib/stores/config";
import { useInsurance } from "@/lib/stores/insurance";
import { useLeases } from "@/lib/stores/leases";
import { useRenewals } from "@/lib/stores/renewals";
import { useUnits } from "@/lib/stores/units";
import { screenHPad } from "@/theme/tokens";

/**
 * Leasing — the Work Orders anatomy applied to the funnel: ONE screen, a mode
 * dropdown (Pipeline · Expirations · Forecast · Vacancy · Renewals ·
 * Compliance), a mode-specific score strip, quick-filter chips with live
 * counts, and banded lists. All board math is lib/derived/leasing.ts
 * (renewals: lib/derived/renewals-view.ts; insurance compliance:
 * lib/derived/insurance-view.ts); this file only renders.
 */

/** Chips filter within a mode; "all" is every mode's default. */
type ChipKey = string;

/** The board modes: the leasing engine's four plus Runway, Renewals, Compliance, Agents. */
type ScreenMode = LeasingMode | "runway" | "renewals" | "compliance" | "agents";

export default function LeasingScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pad = screenHPad(width);
  const wide = width >= 1040;

  const [mode, setMode] = useState<ScreenMode>("pipeline");
  const [chip, setChip] = useState<ChipKey>("all");
  const [headerH, setHeaderH] = useState(insets.top + 150);
  /** Renewal offer sheet target; a fresh nonce remounts the sheet per open. */
  const [offerSheet, setOfferSheet] = useState<{ nonce: number; leaseId: string } | null>(null);
  /** Compliance detail sheet target; same fresh-nonce remount pattern. */
  const [insuranceSheet, setInsuranceSheet] = useState<{ nonce: number; leaseId: string } | null>(
    null,
  );
  /** Pipeline detail sheet target; same fresh-nonce remount pattern. */
  const [pipelineSheet, setPipelineSheet] = useState<{ nonce: number; leaseId: string } | null>(
    null,
  );

  const baseUrl = useConfig((s) => s.baseUrl);
  const token = useConfig((s) => s.token);
  const config = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);

  const leases = useLeases((s) => s.leases);
  const loading = useLeases((s) => s.loading);
  const error = useLeases((s) => s.error);
  const allUnits = useUnits((s) => s.allUnits);
  const workOrders = useWorkOrders((s) => s.workOrders);
  const offers = useRenewals((s) => s.offers);
  const sendOffer = useRenewals((s) => s.sendOffer);
  const resolveOffer = useRenewals((s) => s.resolveOffer);
  const policies = useInsurance((s) => s.policies);
  const insuranceActions = useInsurance((s) => s.actions);
  const logInsuranceAction = useInsurance((s) => s.logAction);

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

  // Runway kanban columns (frame 08): the make-ready engine feeds "In turn",
  // the vacancy book feeds "Leasable now", and the pipeline feeds the rest.
  const makeReadyRows = useMemo(
    () => buildMakeReadyBoard(buildWorkData(workOrders, allUnits), nowMs).rows,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workOrders, allUnits],
  );
  const runway = useMemo(() => {
    const inStage = (stages: PipelineStage[]) => pipelineRows.filter((r) => stages.includes(r.stage));
    return {
      inTurn: makeReadyRows.filter((r) => !r.isReady && !r.isComplete),
      leasable: vacancyRows.filter((r) => r.ready),
      applied: inStage(["application", "screening"]),
      approved: inStage(["approved", "leaseSent"]),
      signed: inStage(["signed", "movedIn"]),
    };
  }, [makeReadyRows, vacancyRows, pipelineRows]);
  const rentFor = useCallback(
    (unitNumber: string) => unitsIdx.get(unitNumber)?.marketRent ?? null,
    [unitsIdx],
  );
  const monthBuckets = useMemo(
    () => expiringByMonth(leases, nowMs, 12),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases],
  );
  const renewalsBoard = useMemo(
    () => buildRenewalsBoard(leases, unitsIdx, offers, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases, unitsIdx, offers],
  );
  const insuranceBoard = useMemo(
    () => buildInsuranceBoard(policies, insuranceActions, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [policies, insuranceActions],
  );
  const agentBoard = useMemo(
    () => buildLeasingAgentBoard(leases, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leases],
  );

  const metrics: BoardMetric[] = useMemo(() => {
    const raw: ScoreMetric[] =
      mode === "renewals"
        ? buildRenewalMetrics(renewalsBoard)
        : mode === "compliance"
          ? buildInsuranceMetrics(insuranceBoard)
          : mode === "agents"
            ? buildLeasingAgentMetrics(agentBoard)
            : mode === "runway"
              ? [] // Runway carries its own flow strip, not the metric band.
              : buildLeasingMetrics({
                  mode, pipelineRows, expirationRows90: expirationRows, forecastRows, vacancyRows, leases, nowMs,
                });
    return raw.map((m: ScoreMetric) => ({
      value: m.value,
      tint: m.tint,
      label: t(m.labelKey),
      caption: m.captionKey ? t(m.captionKey, m.captionParams) : undefined,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pipelineRows, expirationRows, forecastRows, vacancyRows, renewalsBoard, insuranceBoard, leases, t]);

  const modeCounts: Record<ScreenMode, number> = {
    pipeline: pipelineRows.length,
    expirations: expirationRows.length,
    forecast: forecastRows.length,
    vacancy: vacancyRows.length,
    runway: runway.leasable.length,
    renewals: renewalsBoard.total,
    compliance: insuranceBoard.needsAction,
    agents: agentBoard.rows.filter((r) => !r.isOffice).length,
  };

  const onMode = (key: string) => {
    const next = key as ScreenMode;
    capture("board_mode_switched", { mode: `leasing:${next}` });
    setMode(next);
    setChip("all");
  };

  // ── Quick chips per mode (live counts) ────────────────────────────────────
  const chips: QuickChip[] = useMemo(() => {
    if (mode === "pipeline") {
      // The artifact's quick filters: the questions a leasing manager asks of
      // the funnel ("who lands this week? which units can't take them? who
      // hasn't signed?"), plus one chip per active leasing agent in place of
      // the mockup's "By agent" dropdown — same capability, existing chip UI.
      const agents = [...new Set(pipelineRows.map((r) => r.lease.leasingAgent).filter(Boolean))].sort();
      return [
        { key: "all", label: t("leasing.chips.all"), count: pipelineRows.length },
        { key: "thisWeek", label: t("leasing.chips.thisWeek"), count: pipelineRows.filter((r) => r.imminent).length },
        { key: "notReady", label: t("leasing.chips.unitNotReady"), count: pipelineRows.filter((r) => !r.ready).length },
        { key: "unsigned", label: t("leasing.chips.unsigned"), count: pipelineRows.filter((r) => isAwaitingSignature(r.stage)).length },
        ...agents.map((agent) => ({
          key: `agent:${agent}`,
          label: agent.split(" ")[0] ?? agent,
          count: pipelineRows.filter((r) => r.lease.leasingAgent === agent).length,
        })),
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
    if (mode === "renewals") {
      return [
        { key: "all", label: t("leasing.chips.all"), count: renewalsBoard.total },
        {
          key: "needsOffer",
          label: t("leasing.renewals.chips.needsOffer"),
          count: renewalsBoard.needsOffer.length,
        },
        {
          key: "noResponse",
          label: t("leasing.renewals.chips.noResponse"),
          count: renewalsBoard.silentCount,
        },
        {
          key: "accepted",
          label: t("leasing.renewals.chips.accepted"),
          count: renewalsBoard.resolvedThisMonth.filter((r) => r.accepted).length,
        },
      ];
    }
    if (mode === "compliance") {
      return [
        {
          key: "all",
          label: t("leasing.compliance.chips.needsAction"),
          count: insuranceBoard.needsAction,
        },
        {
          key: "lapsed",
          label: t("leasing.compliance.chips.lapsed"),
          count: insuranceBoard.lapsed.length,
        },
        {
          key: "expiring",
          label: t("leasing.compliance.chips.expiring"),
          count: insuranceBoard.expiring.length,
        },
        {
          key: "neverFiled",
          label: t("leasing.compliance.chips.neverFiled"),
          count: insuranceBoard.neverFiled.length,
        },
      ];
    }
    return [];
  }, [mode, pipelineRows, expirationRows, vacancyRows, renewalsBoard, insuranceBoard, t]);

  // ── Chip-filtered lists ───────────────────────────────────────────────────
  const visiblePipeline = useMemo(() => {
    if (chip === "thisWeek") return pipelineRows.filter((r) => r.imminent);
    if (chip === "notReady") return pipelineRows.filter((r) => !r.ready);
    if (chip === "unsigned") return pipelineRows.filter((r) => isAwaitingSignature(r.stage));
    if (chip.startsWith("agent:")) {
      return pipelineRows.filter((r) => r.lease.leasingAgent === chip.slice("agent:".length));
    }
    return pipelineRows;
  }, [pipelineRows, chip]);
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
    // The approved artifact's banding: imminent move-ins pinned on top (hot),
    // then one band per stage, later stages first — a shaped funnel instead of
    // the old flat "in flight" bucket.
    const imminent = visiblePipeline.filter((r) => r.imminent);
    const rest = visiblePipeline.filter((r) => !r.imminent);
    const rowViews = (rows: PipelineRow[]) =>
      rows.map((r, i) => (
        <PipelineRowView
          key={r.lease.id}
          row={r}
          last={i === rows.length - 1}
          nowMs={nowMs}
          onPress={() => setPipelineSheet({ nonce: Date.now(), leaseId: r.lease.id })}
        />
      ));
    if (visiblePipeline.length === 0) return emptyState;
    return (
      <View style={{ gap: 4 }}>
        {band(t("leasing.bands.moveInThisWeek", { count: imminent.length }), true, rowViews(imminent), "imminent")}
        {PIPELINE_STAGE_ORDER.map((stage) => {
          const rows = rest.filter((r) => r.stage === stage);
          return band(
            `${t(`leasing.stages.${stage}`)} · ${rows.length}`,
            false,
            rowViews(rows),
            `stage-${stage}`,
          );
        })}
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

  // ── Renewals mode ─────────────────────────────────────────────────────────
  // The bumped nonce remounts the sheet with fresh state on every open.
  const openOfferSheet = (leaseId: string) => {
    setOfferSheet((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, leaseId }));
  };

  const renewalsBody = () => {
    const needsOffer =
      chip === "noResponse" || chip === "accepted" ? [] : renewalsBoard.needsOffer;
    const offersOut =
      chip === "needsOffer" || chip === "accepted"
        ? []
        : chip === "noResponse"
          ? renewalsBoard.offersOut.filter((r) => r.silent)
          : renewalsBoard.offersOut;
    const resolved =
      chip === "needsOffer" || chip === "noResponse"
        ? []
        : chip === "accepted"
          ? renewalsBoard.resolvedThisMonth.filter((r) => r.accepted)
          : renewalsBoard.resolvedThisMonth;

    const urgent = needsOffer.filter((r) => r.urgent);
    const later = needsOffer.filter((r) => !r.urgent);
    if (needsOffer.length + offersOut.length + resolved.length === 0) return emptyState;
    return (
      <View style={{ gap: 4 }}>
        {band(
          t("leasing.renewals.bands.needsOfferUrgent"), true,
          urgent.map((r, i) => (
            <NeedsOfferRowView
              key={r.expiration.lease.id}
              row={r}
              last={i === urgent.length - 1}
              onPress={() => openOfferSheet(r.expiration.lease.id)}
            />
          )),
          "needsOfferUrgent",
        )}
        {band(
          t("leasing.renewals.bands.needsOfferLater"), false,
          later.map((r, i) => (
            <NeedsOfferRowView
              key={r.expiration.lease.id}
              row={r}
              last={i === later.length - 1}
              onPress={() => openOfferSheet(r.expiration.lease.id)}
            />
          )),
          "needsOfferLater",
        )}
        {band(
          t("leasing.renewals.bands.offerSent"), false,
          offersOut.map((r, i) => (
            <OfferSentRowView
              key={r.offer.id}
              row={r}
              last={i === offersOut.length - 1}
              onPress={() => (r.lease ? openOfferSheet(r.lease.id) : undefined)}
            />
          )),
          "offerSent",
        )}
        {band(
          t("leasing.renewals.bands.resolved"), false,
          resolved.map((r, i) => (
            <ResolvedRowView
              key={r.offer.id}
              row={r}
              last={i === resolved.length - 1}
              onPress={r.lease ? () => openOfferSheet(r.lease!.id) : undefined}
            />
          )),
          "resolved",
        )}
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 10.5, textAlign: "center", paddingVertical: 12 }}
        >
          {t("leasing.renewals.foot")}
        </Text>
      </View>
    );
  };

  // ── Compliance mode ───────────────────────────────────────────────────────
  const openInsuranceSheet = (leaseId: string) => {
    setInsuranceSheet((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, leaseId }));
  };

  const complianceBody = () => {
    const lapsed = chip === "expiring" || chip === "neverFiled" ? [] : insuranceBoard.lapsed;
    const expiring = chip === "lapsed" || chip === "neverFiled" ? [] : insuranceBoard.expiring;
    const neverFiled =
      chip === "lapsed" || chip === "expiring" ? [] : insuranceBoard.neverFiled;

    if (lapsed.length + expiring.length + neverFiled.length === 0) return emptyState;
    return (
      <View style={{ gap: 4 }}>
        <CoverageBar
          covered={insuranceBoard.distribution.covered}
          expiring={insuranceBoard.distribution.expiring}
          lapsed={insuranceBoard.distribution.lapsed}
          none={insuranceBoard.distribution.none}
        />
        {band(
          t("leasing.compliance.bands.lapsed"), true,
          lapsed.map((r, i) => (
            <LapsedRowView
              key={r.policy.leaseId}
              row={r}
              last={i === lapsed.length - 1}
              onPress={() => openInsuranceSheet(r.policy.leaseId)}
            />
          )),
          "lapsed",
        )}
        {band(
          t("leasing.compliance.bands.expiring", { count: expiring.length }), false,
          expiring.map((r, i) => (
            <ExpiringRowView
              key={r.policy.leaseId}
              row={r}
              last={i === expiring.length - 1}
              onPress={() => openInsuranceSheet(r.policy.leaseId)}
            />
          )),
          "expiring",
        )}
        {band(
          t("leasing.compliance.bands.neverFiled", { count: neverFiled.length }), false,
          neverFiled.map((r, i) => (
            <NeverFiledRowView
              key={r.policy.leaseId}
              row={r}
              last={i === neverFiled.length - 1}
              onPress={() => openInsuranceSheet(r.policy.leaseId)}
            />
          )),
          "neverFiled",
        )}
      </View>
    );
  };

  // ── Pipeline sheet wiring ─────────────────────────────────────────────────
  const pipelineSheetRow: PipelineRow | null = pipelineSheet
    ? pipelineRows.find((r) => r.lease.id === pipelineSheet.leaseId) ?? null
    : null;
  // The unit's make-ready tickets, open first — "what's holding the unit up".
  const pipelineSheetTurnWos = useMemo(() => {
    if (!pipelineSheetRow) return [];
    return buildWorkData(workOrders, allUnits)
      .parsed.filter(
        (wo) => wo.isMakeReady && wo.unitNumber === pipelineSheetRow.lease.unitNumber,
      )
      .map((wo) => ({
        id: wo.id,
        number: wo.number,
        title: wo.title,
        status: wo.status,
        open: !isClosedWorkOrder(wo),
      }))
      .sort((a, b) => Number(b.open) - Number(a.open));
  }, [pipelineSheetRow, workOrders, allUnits]);

  // ── Compliance sheet wiring ───────────────────────────────────────────────
  const insuranceRow: InsuranceRowView | null = insuranceSheet
    ? insuranceBoard.rows.find((r) => r.policy.leaseId === insuranceSheet.leaseId) ?? null
    : null;
  const insuranceLeaseActions = insuranceRow
    ? actionsByLease(insuranceActions).get(insuranceRow.policy.leaseId) ?? []
    : [];
  const insuranceTimeline = insuranceRow
    ? buildInsuranceTimeline(insuranceRow, insuranceLeaseActions)
    : [];
  const insuranceUnit = insuranceRow
    ? allUnits.find((u) => u.number === insuranceRow.policy.unitNumber) ?? null
    : null;

  const submitInsuranceAction = async (
    kind: InsuranceActionKind,
    note?: string,
  ): Promise<boolean> => {
    if (!insuranceRow) return false;
    const ok = await logInsuranceAction(config, {
      resmanLeaseId: insuranceRow.policy.leaseId,
      unitNumber: insuranceRow.policy.unitNumber || undefined,
      kind,
      note,
    });
    if (ok) capture("insurance_action_logged", { kind });
    return ok;
  };

  // ── Offer sheet wiring ────────────────────────────────────────────────────
  const sheetLease = offerSheet ? leases.find((l) => l.id === offerSheet.leaseId) ?? null : null;
  const sheetSubject = sheetLease ? renewalSubject(sheetLease, allUnits) : null;
  const sheetComps = sheetLease ? buildInternalComps(sheetLease, leases, allUnits, nowMs) : null;
  const sheetActiveOffer = sheetLease
    ? (() => {
        const governing = governingOfferByLease(offers).get(sheetLease.id);
        return governing && governing.status === "sent" ? governing : null;
      })()
    : null;
  const sheetTimeline = sheetLease ? buildOfferTimeline(sheetLease, offers, nowMs) : [];

  const submitOffer = async (draft: RenewalOfferDraft): Promise<boolean> => {
    if (!sheetLease) return false;
    const ok = await sendOffer(config, {
      resmanLeaseId: sheetLease.id,
      resmanUnitId: sheetLease.unitId ?? undefined,
      unitNumber: sheetLease.unitNumber || undefined,
      ...draft,
    });
    if (ok) {
      capture("renewal_offer_sent", {
        termMonths: draft.termMonths ?? null,
        isMonthToMonth: draft.isMonthToMonth === true,
      });
    }
    return ok;
  };

  const submitResolve = async (
    offerId: string,
    status: RenewalResolutionStatus,
  ): Promise<boolean> => {
    const ok = await resolveOffer(config, offerId, status);
    if (ok) capture("renewal_offer_resolved", { status });
    return ok;
  };

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
          { key: "runway", label: t("leasing.modes.runway"), icon: "git-branch-outline", count: modeCounts.runway },
          { key: "expirations", label: t("leasing.modes.expirations"), icon: "calendar-outline", count: modeCounts.expirations },
          { key: "forecast", label: t("leasing.modes.forecast"), icon: "trending-up-outline" },
          { key: "vacancy", label: t("leasing.modes.vacancy"), icon: "home-outline", count: modeCounts.vacancy },
          { key: "renewals", label: t("leasing.modes.renewals"), icon: "refresh-outline", count: modeCounts.renewals },
          { key: "compliance", label: t("leasing.modes.compliance"), icon: "shield-checkmark-outline", count: modeCounts.compliance },
          { key: "agents", label: t("leasing.modes.agents"), icon: "people-outline", count: modeCounts.agents },
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
        <View
          style={{
            paddingHorizontal: pad,
            // Pipeline joins the wide modes: its rows carry the five-step
            // tracker plus three text columns, and squeezing that into 860pt
            // truncated the agent and applied-date lines off the row.
            maxWidth:
              wide &&
              mode !== "pipeline" &&
              mode !== "expirations" &&
              mode !== "agents" &&
              mode !== "runway"
                ? 860
                : undefined,
          }}
        >
          {mode === "pipeline"
            ? pipelineBody()
            : mode === "runway"
              ? (
                  <RunwayBoard
                    inTurn={runway.inTurn}
                    leasable={runway.leasable}
                    applied={runway.applied}
                    approved={runway.approved}
                    signed={runway.signed}
                    rentFor={rentFor}
                  />
                )
              : mode === "expirations"
                ? expirationsBody()
                : mode === "forecast"
                  ? forecastBody()
                  : mode === "renewals"
                    ? renewalsBody()
                    : mode === "compliance"
                      ? complianceBody()
                      : mode === "agents"
                        ? <AgentsBoard board={agentBoard} />
                        : vacancyBody()}
        </View>
      </ScrollView>

      {offerSheet && sheetLease && sheetSubject ? (
        <RenewalOfferSheet
          key={offerSheet.nonce}
          visible
          lease={sheetLease}
          subject={sheetSubject}
          comps={sheetComps}
          activeOffer={sheetActiveOffer}
          timeline={sheetTimeline}
          onClose={() => setOfferSheet(null)}
          onSend={submitOffer}
          onResolve={submitResolve}
        />
      ) : null}

      {pipelineSheet && pipelineSheetRow ? (
        <PipelineDetailSheet
          key={pipelineSheet.nonce}
          visible
          row={pipelineSheetRow}
          turnWorkOrders={pipelineSheetTurnWos}
          config={config}
          nowMs={nowMs}
          onClose={() => setPipelineSheet(null)}
        />
      ) : null}

      {insuranceSheet && insuranceRow ? (
        <InsuranceDetailSheet
          key={insuranceSheet.nonce}
          visible
          row={insuranceRow}
          bedrooms={typeof insuranceUnit?.bedrooms === "number" ? insuranceUnit.bedrooms : null}
          classification={insuranceUnit?.classification ?? ""}
          timeline={insuranceTimeline}
          onClose={() => setInsuranceSheet(null)}
          onLog={submitInsuranceAction}
        />
      ) : null}
    </View>
  );
}

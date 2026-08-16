import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { AgentStat } from "@emberly/core";
import { AgentDetailBody } from "@/components/delinquency/AgentDetail";
import { AgentsList } from "@/components/delinquency/AgentsList";
import { BalancesList, type BalancesFilter, type BalancesGrouping } from "@/components/delinquency/BalancesList";
import { DetailSheet } from "@/components/delinquency/DetailSheet";
import { LogActionSheet, type LogActionDraft } from "@/components/delinquency/LogActionSheet";
import { TenantDetailBody } from "@/components/delinquency/TenantDetail";
import { TenantsList } from "@/components/delinquency/TenantsList";
import { MONEY_COLORS } from "@/components/delinquency/bits";
import { fmtMoney, fmtMoneyCompact, fmtMonthYear, fmtPercent } from "@/components/delinquency/format";
import { capture } from "@/lib/analytics";
import type { DelinquencyActionKind } from "@/lib/api/delinquency";
import {
  agentDrillIn,
  assembleTenantPnl,
  buildAgentBoard,
  buildBalancesBoard,
  buildTimeline,
  lastPaymentMap,
  legalMap,
  tenantBands,
  type QueueRow,
  type TenantPnl,
} from "@/lib/derived/delinquency-view";
import { useConfig } from "@/lib/stores/config";
import { useDelinquency } from "@/lib/stores/delinquency";
import { useLedger } from "@/lib/stores/ledger";
import { useUnits } from "@/lib/stores/units";
import { BoardHeader, type BoardMetric, type BoardMode } from "@/components/ui/BoardHeader";
import { HAIRLINE } from "@/theme/tokens";

type Mode = "balances" | "tenants" | "agents";

/** Signing window for the agent scorecards — matches the API's lease window. */
const AGENT_WINDOW_MONTHS = 24;

/** iPad split threshold: list-left / detail-right at and above this width. */
const SPLIT_MIN_WIDTH = 1040;

/**
 * Money — the delinquency board. Three modes: Balances (the banded action
 * queue over aging buckets), Tenants (lifetime P&L per lease with verdicts),
 * Agents (leasing-agent screening-quality scorecards). Balances/Tenants run
 * split view on iPad; the phone opens the same detail as a bottom sheet.
 */
export default function DelinquencyScreen() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_MIN_WIDTH;

  const [mode, setMode] = useState<Mode>("balances");
  const [headerH, setHeaderH] = useState(0);
  const [filter, setFilter] = useState<BalancesFilter>("all");
  const [grouping, setGrouping] = useState<BalancesGrouping>("priority");
  const [selectedLeaseId, setSelectedLeaseId] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [tenantSheetOpen, setTenantSheetOpen] = useState(false);
  const [agentSheetOpen, setAgentSheetOpen] = useState(false);
  const [actionSheet, setActionSheet] = useState<{ nonce: number; kind: DelinquencyActionKind } | null>(null);

  const baseUrl = useConfig((s) => s.baseUrl);
  const token = useConfig((s) => s.token);
  const config = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);

  const units = useDelinquency((s) => s.units);
  const actions = useDelinquency((s) => s.actions);
  const leases = useDelinquency((s) => s.leases);
  const loading = useDelinquency((s) => s.loading);
  const refreshedAt = useDelinquency((s) => s.refreshedAt);
  const logAction = useDelinquency((s) => s.logAction);
  const summaries = useLedger((s) => s.summaries);
  const entriesByLease = useLedger((s) => s.entriesByLease);
  const loadingLease = useLedger((s) => s.loadingLease);
  const loadLease = useLedger((s) => s.loadLease);
  const allUnits = useUnits((s) => s.allUnits);

  // ---- derivations (all pure; see lib/derived/delinquency-view.ts) --------
  // "Now" for bucketing/promise math: the last sync's timestamp (moves with
  // every tick), falling back to mount time on a cold cache. Keeping it out
  // of render bodies satisfies React purity — no Date.now() during render.
  const [mountedAt] = useState(() => Date.now());
  const nowMs = refreshedAt > 0 ? refreshedAt : mountedAt;
  const lastPayment = useMemo(() => lastPaymentMap(summaries), [summaries]);
  // Eviction filings come off the ledger's attorney/court fees, not the
  // delinquency note — the note is blank on 83 of the 151 leases with a filing.
  const legal = useMemo(() => legalMap(summaries), [summaries]);
  // The delinquency report has no move-in date, so tenure is joined from the
  // leases already loaded for the agent board. Keyed by unit: a unit's current
  // lease is the tenancy standing behind its balance.
  const moveInByUnit = useMemo(() => {
    const out = new Map<string, string>();
    for (const lease of leases) {
      if (!lease.unitId || !lease.isCurrentLease || !lease.moveInDate) continue;
      out.set(lease.unitId, lease.moveInDate);
    }
    return out;
  }, [leases]);
  const summaryByLease = useMemo(() => new Map(summaries.map((s) => [s.leaseId, s])), [summaries]);
  // The resident's OWN monthly rent, which on a subsidised unit is a fraction
  // of market — and is the right denominator for "months of rent missing".
  const rentByUnit = useMemo(() => {
    const out = new Map<string, number>();
    for (const lease of leases) {
      if (!lease.unitId || !lease.isCurrentLease) continue;
      const rent = lease.residentRent ?? lease.marketRent ?? null;
      if (typeof rent === "number" && rent > 0) out.set(lease.unitId, rent);
    }
    return out;
  }, [leases]);
  const board = useMemo(
    () =>
      buildBalancesBoard(units, actions, lastPayment, nowMs, moveInByUnit, legal, summaryByLease, rentByUnit),
    [units, actions, lastPayment, nowMs, moveInByUnit, legal, summaryByLease, rentByUnit],
  );
  const pnls = useMemo(
    () => assembleTenantPnl({ leases, units, summaries, actions, nowMs }),
    [leases, units, summaries, actions, nowMs],
  );
  const bands = useMemo(() => tenantBands(pnls), [pnls]);
  const agentBoard = useMemo(
    () =>
      buildAgentBoard(leases, units, summaries, actions, {
        windowMonths: AGENT_WINDOW_MONTHS,
        nowMs,
      }),
    [leases, units, summaries, actions, nowMs],
  );

  // ---- selection ----------------------------------------------------------
  const selUnit = useMemo(
    () => units.find((u) => u.unitId === selectedUnitId) ?? null,
    [units, selectedUnitId],
  );
  const selLease = useMemo(
    () => leases.find((l) => l.id === selectedLeaseId) ?? null,
    [leases, selectedLeaseId],
  );
  const selPnl = useMemo(
    () => (selectedLeaseId ? (pnls.find((p) => p.leaseId === selectedLeaseId) ?? null) : null),
    [pnls, selectedLeaseId],
  );
  const selResmanUnit = useMemo(
    () => allUnits.find((u) => u.resman_unit_id === (selectedUnitId ?? selPnl?.unitId)) ?? null,
    [allUnits, selectedUnitId, selPnl],
  );
  const timeline = useMemo(
    () =>
      selectedLeaseId
        ? buildTimeline(entriesByLease[selectedLeaseId] ?? [], actions, selectedLeaseId)
        : [],
    [entriesByLease, actions, selectedLeaseId],
  );
  const selStat: AgentStat | null = useMemo(
    () => agentBoard.stats.find((s) => s.agent === selectedAgent) ?? null,
    [agentBoard, selectedAgent],
  );
  const selDrill = useMemo(
    () => (selectedAgent ? agentDrillIn(selectedAgent, leases, units, summaries, actions) : null),
    [selectedAgent, leases, units, summaries, actions],
  );

  const openTenant = (leaseId: string | null, unitId: string | null) => {
    setSelectedLeaseId(leaseId);
    setSelectedUnitId(unitId);
    if (!split) setTenantSheetOpen(true);
    capture("tenant_sheet_opened");
    if (leaseId) void loadLease(config, leaseId);
  };

  const onSelectBalanceRow = (row: QueueRow) => openTenant(row.unit.currentLeaseId ?? null, row.unit.unitId);
  const onSelectTenant = (pnl: TenantPnl) => openTenant(pnl.leaseId, pnl.unitId);
  const onSelectAgent = (stat: AgentStat) => {
    setSelectedAgent(stat.agent);
    setAgentSheetOpen(true);
  };

  const onModeChange = (key: string) => {
    setMode(key as Mode);
    capture("board_mode_switched", { mode: `delinquency:${key}` });
  };

  // ---- tenant detail identity ---------------------------------------------
  const detailTitle = (() => {
    const unitNumber = selUnit?.unitNumber ?? selPnl?.unitNumber ?? selLease?.unitNumber ?? "";
    const name = selUnit?.tenantNames[0] ?? selPnl?.tenantName ?? "";
    return name ? `${unitNumber} · ${name}` : unitNumber || t("delinquency.row.former");
  })();
  const detailSubtitle = (() => {
    const parts: string[] = [];
    if (selResmanUnit?.bedrooms) {
      parts.push(
        `${selResmanUnit.bedrooms}BR${selResmanUnit.classification ? ` ${selResmanUnit.classification}` : ""}`,
      );
    }
    const moveIn = selPnl?.moveInDate ?? selLease?.moveInDate ?? selResmanUnit?.move_in_date ?? null;
    if (moveIn) parts.push(t("delinquency.sheet.movedIn", { date: fmtMonthYear(moveIn) }));
    const rent = selLease?.residentRent ?? selResmanUnit?.lease_rent ?? null;
    if (typeof rent === "number" && rent > 0) parts.push(t("delinquency.sheet.perMonth", { amount: fmtMoney(rent) }));
    const agent = selPnl?.leasingAgent || selUnit?.leasingAgent || selLease?.leasingAgent || "";
    if (agent) parts.push(t("delinquency.sheet.signedBy", { agent }));
    return parts.join(" · ");
  })();

  const detailBalance = Math.max(
    0,
    selPnl?.openBalance ?? (typeof selUnit?.balance === "number" ? selUnit.balance : 0),
  );

  const submitAction = async (draft: LogActionDraft): Promise<boolean> => {
    if (!selectedLeaseId) return false;
    const ok = await logAction(config, {
      resmanLeaseId: selectedLeaseId,
      resmanUnitId: selectedUnitId ?? selPnl?.unitId ?? undefined,
      unitNumber: selUnit?.unitNumber ?? selPnl?.unitNumber ?? undefined,
      ...draft,
    });
    if (ok) capture("delinquency_action_logged", { kind: draft.kind });
    return ok;
  };

  const openActionSheet = (kind: DelinquencyActionKind) => {
    if (!selectedLeaseId) return;
    setActionSheet({ nonce: Date.now(), kind });
  };

  // ---- header -------------------------------------------------------------
  const modes: BoardMode[] = [
    { key: "balances", label: t("delinquency.modes.balances"), icon: "cash-outline", count: board.rows.length },
    { key: "tenants", label: t("delinquency.modes.tenants"), icon: "people-outline", count: pnls.length },
    { key: "agents", label: t("delinquency.modes.agents"), icon: "medal-outline", count: agentBoard.stats.length },
  ];

  const metrics: BoardMetric[] = (() => {
    if (mode === "balances") {
      const ninetyPlus = board.distribution.segments.find((s) => s.bucket === "90+");
      return [
        {
          value: fmtMoneyCompact(board.totalOwed),
          tint: MONEY_COLORS.bad,
          label: t("delinquency.metrics.totalOwed"),
          caption: t("delinquency.metrics.unitsOwe", { count: board.rows.length }),
          onPress: () => setFilter("all"),
        },
        {
          value: fmtMoneyCompact(ninetyPlus?.amount ?? 0),
          tint: MONEY_COLORS.deepRed,
          label: t("delinquency.metrics.ninetyPlus"),
          caption: t("delinquency.metrics.ninetyPlusUnits", { count: board.ninetyPlusCount }),
          onPress: () => setFilter("ninetyPlus"),
        },
        {
          value: String(board.evictionCount),
          tint: MONEY_COLORS.warn,
          label: t("delinquency.metrics.evictions"),
          caption: t("delinquency.metrics.fedFiled", { count: board.fedFiledCount }),
          onPress: () => setFilter("eviction"),
        },
      ];
    }
    if (mode === "tenants") {
      const billed = pnls.reduce((acc, p) => acc + p.billed, 0);
      const collected = pnls.reduce((acc, p) => acc + p.collected, 0);
      const lossTotal = bands.losses.reduce((acc, p) => acc + p.net, 0);
      const writeoffTotal = summaries.reduce((acc, s) => acc + Math.max(0, s.writeoffs), 0);
      const writeoffLeases = summaries.filter((s) => s.writeoffs > 0).length;
      return [
        {
          value: billed > 0 ? fmtPercent(collected / billed) : "—",
          tint: MONEY_COLORS.pos,
          label: t("delinquency.metrics.collection"),
          caption: t("delinquency.metrics.collectionCaption"),
        },
        {
          value: String(bands.losses.length),
          tint: MONEY_COLORS.bad,
          label: t("delinquency.metrics.lossLeases"),
          caption: t("delinquency.metrics.lossCombined", { amount: fmtMoneyCompact(lossTotal) }),
        },
        {
          value: fmtMoneyCompact(writeoffTotal),
          tint: MONEY_COLORS.purple,
          label: t("delinquency.metrics.writtenOff"),
          caption: t("delinquency.metrics.writtenOffLeases", { count: writeoffLeases }),
        },
      ];
    }
    return [
      {
        value: String(agentBoard.totalSigned),
        label: t("delinquency.metrics.leasesSigned"),
        caption: t("delinquency.metrics.signedWindow", { months: AGENT_WINDOW_MONTHS }),
      },
      {
        value: fmtPercent(agentBoard.overallEvictionRate),
        tint: MONEY_COLORS.bad,
        label: t("delinquency.metrics.evictionRate"),
        // Over TENANCIES, and counting every eviction — including the ones on
        // leases with no agent recorded, which no scorecard below can show.
        caption: t("delinquency.metrics.evictionOf", {
          evictions: agentBoard.totalEvictions,
          total: agentBoard.totalTenancies,
        }),
      },
      {
        value: fmtPercent(agentBoard.overallDelinquencyLoad),
        tint: MONEY_COLORS.warn,
        label: t("delinquency.metrics.delinquencyLoad"),
        caption: t("delinquency.metrics.loadCaption"),
      },
    ];
  })();

  // ---- bodies -------------------------------------------------------------
  const listBody =
    mode === "balances" ? (
      <BalancesList
        board={board}
        filter={filter}
        onFilter={setFilter}
        grouping={grouping}
        onGrouping={setGrouping}
        selectedUnitId={split ? selectedUnitId : null}
        onSelect={onSelectBalanceRow}
      />
    ) : mode === "tenants" ? (
      <TenantsList bands={bands} selectedLeaseId={split ? selectedLeaseId : null} onSelect={onSelectTenant} />
    ) : (
      <AgentsList
        stats={agentBoard.stats}
        selectedAgent={selectedAgent}
        onSelect={onSelectAgent}
        unattributedLeases={agentBoard.unattributedLeases}
        unattributedEvictions={agentBoard.unattributedEvictions}
      />
    );

  const tenantDetailBody = (
    <TenantDetailBody
      pnl={selPnl}
      balance={detailBalance}
      timesLate={selPnl?.timesLate ?? (typeof selUnit?.timesLate === "number" ? selUnit.timesLate : 0)}
      timeline={timeline}
      loadingLedger={selectedLeaseId !== null && loadingLease === selectedLeaseId}
      ledgerMissing={
        selectedLeaseId === null ||
        (loadingLease !== selectedLeaseId && !entriesByLease[selectedLeaseId])
      }
      onLogAction={() => openActionSheet("note")}
      onRecordPromise={() => openActionSheet("promise_recorded")}
    />
  );

  const showSpinner = loading && units.length === 0;
  const splitTenantModes = split && mode !== "agents";
  const hasSelection = selectedUnitId !== null || selectedLeaseId !== null;

  return (
    <View style={{ flex: 1 }}>
      <BoardHeader
        modes={modes}
        activeMode={mode}
        onMode={onModeChange}
        metrics={metrics}
        onHeight={setHeaderH}
      />

      {showSpinner ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: headerH }}>
          <ActivityIndicator />
        </View>
      ) : splitTenantModes ? (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ width: 430, borderRightWidth: 1, borderRightColor: HAIRLINE }}>
            <ScrollView contentContainerStyle={{ paddingTop: headerH + 6, paddingBottom: 120 }}>
              {listBody}
            </ScrollView>
          </View>
          <View style={{ flex: 1 }}>
            {hasSelection ? (
              <ScrollView contentContainerStyle={{ paddingTop: headerH + 6, paddingBottom: 120 }}>
                <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
                  <Text style={{ fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: MONEY_COLORS.navy }}>
                    {detailTitle}
                  </Text>
                  {detailSubtitle ? (
                    <Text style={{ fontSize: 10.5, color: MONEY_COLORS.muted, marginTop: 2 }}>{detailSubtitle}</Text>
                  ) : null}
                </View>
                {tenantDetailBody}
              </ScrollView>
            ) : (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: headerH }}>
                <Text style={{ fontSize: 12.5, color: MONEY_COLORS.muted }}>
                  {t("delinquency.sheet.selectPrompt")}
                </Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingTop: headerH + 6, paddingBottom: 120 }}>
          {listBody}
        </ScrollView>
      )}

      {/* Phone: tenant detail rides a bottom sheet. */}
      {!split ? (
        <DetailSheet
          visible={tenantSheetOpen}
          onClose={() => setTenantSheetOpen(false)}
          title={detailTitle}
          subtitle={detailSubtitle}
        >
          {tenantDetailBody}
        </DetailSheet>
      ) : null}

      {/* Agent drill-in — sheet on all sizes. */}
      <DetailSheet
        visible={agentSheetOpen && selStat !== null}
        onClose={() => setAgentSheetOpen(false)}
        title={selectedAgent ? t("delinquency.agents.drillTitle", { agent: selectedAgent }) : ""}
        subtitle={
          selStat
            ? t("delinquency.agents.drillSubtitle", {
                signed: selStat.leasesSigned,
                active: selStat.active,
                evictions: selStat.evictions,
                delinquent: selStat.delinquentCount,
              })
            : undefined
        }
      >
        {selStat && selDrill ? <AgentDetailBody stat={selStat} drill={selDrill} /> : null}
      </DetailSheet>

      {actionSheet ? (
        <LogActionSheet
          key={actionSheet.nonce}
          visible
          initialKind={actionSheet.kind}
          onClose={() => setActionSheet(null)}
          onSubmit={submitAction}
        />
      ) : null}
    </View>
  );
}

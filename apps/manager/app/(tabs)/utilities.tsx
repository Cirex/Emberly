import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { BoardHeader, type BoardMetric, type BoardMode } from "@/components/ui/BoardHeader";
import { ExceptionsBoard } from "@/components/utilities/ExceptionsBoard";
import { LedgerBoard } from "@/components/utilities/LedgerBoard";
import { OverviewBoard, type OverviewData } from "@/components/utilities/OverviewBoard";
import { PayablesBoard } from "@/components/utilities/PayablesBoard";
import { capture } from "@/lib/analytics";
import type { MlgwCurrentBill } from "@/lib/api/mlgw";
import {
  billsByAccount,
  buildPayables,
  buildUtilitySummary,
  chargeMixSegments,
  computeUtilityExceptions,
  groupExceptionsByUnit,
  monthOverMonth,
  monthlySpendSeries,
  type ExceptionCopy,
  type UtilityException,
} from "@/lib/derived/utility-exceptions";
import {
  formatMoney,
  formatMoneyWhole,
  formatShortDate,
} from "@/lib/derived/utility-format";
import { activeLocale } from "@/lib/i18n";
import { useConfig } from "@/lib/stores/config";
import { useMlgw } from "@/lib/stores/mlgw";
import { useUnits } from "@/lib/stores/units";
import { MUTED, screenHPad } from "@/theme/tokens";

/**
 * Utilities — the XMS utilities suite in the Emberly shell: Overview · Ledger
 * · Payables · Exceptions over the synced MLGW mirror. All derivation lives in
 * lib/derived/utility-exceptions.ts (pure + tested); this screen wires the
 * stores to the boards and the BoardHeader.
 */

type UtilityMode = "overview" | "ledger" | "payables" | "exceptions";

// Evaluated once per app launch (module scope keeps render pure). Every date
// rule here works at day granularity, so a session crossing midnight only
// shifts past-due/due-soon boundaries by one day until the next cold start.
const TODAY_ISO = new Date().toISOString().slice(0, 10);

export default function UtilitiesScreen() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const isWide = width >= 1040;
  const locale = activeLocale();

  const baseUrl = useConfig((s) => s.baseUrl);
  const token = useConfig((s) => s.token);
  const config = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);

  const data = useMlgw((s) => s.data);
  const loading = useMlgw((s) => s.loading);
  const error = useMlgw((s) => s.error);
  const allUnits = useUnits((s) => s.allUnits);

  const [mode, setMode] = useState<UtilityMode>("overview");
  const [headerH, setHeaderH] = useState(0);

  // The sync tick owns refreshes; this only covers the cold cache on first
  // visit (idempotent — load() no-ops while a load is already in flight).
  useEffect(() => {
    if (data === null && token) void useMlgw.getState().load(config);
  }, [data, token, config]);

  // Display-copy seam for the pure engine — everything routes through i18next.
  const copy: ExceptionCopy = useMemo(
    () => ({
      title: (kind) => t(`utilities.kinds.${kind}.title`),
      action: (kind) => t(`utilities.kinds.${kind}.action`),
      detail: (kind, ctx) => {
        switch (kind) {
          case "spike":
            return t("utilities.kinds.spike.detail", {
              amount: formatMoney(ctx.amount),
              typical: formatMoney(ctx.typical ?? 0),
            });
          case "high_electrical":
            return ctx.typical !== undefined
              ? t("utilities.kinds.high_electrical.detailWithTypical", {
                  amount: formatMoney(ctx.amount),
                  typical: formatMoney(ctx.typical),
                })
              : t("utilities.kinds.high_electrical.detail", { amount: formatMoney(ctx.amount) });
          case "billed_after_move_in":
            return t("utilities.kinds.billed_after_move_in.detail", {
              billDate: formatShortDate(ctx.billDate, locale),
              moveInDate: formatShortDate(ctx.moveInDate, locale),
            });
          case "balance_forward":
            return t("utilities.kinds.balance_forward.detail", { amount: formatMoney(ctx.amount) });
          case "fee_spike":
            return t("utilities.kinds.fee_spike.detail", {
              fee: t(`utilities.fees.${ctx.feeKey ?? "generic"}`),
              amount: formatMoney(ctx.amount),
            });
          case "past_due":
            return t("utilities.kinds.past_due.detail", {
              date: formatShortDate(ctx.dueDate, locale),
              amount: formatMoney(ctx.amount),
            });
        }
      },
    }),
    [t, locale],
  );

  const derived = useMemo(() => {
    const payload = data ?? { accounts: [], currentBills: [], monthlyTotals: [], reviews: [] };
    const units = allUnits.map((u) => ({ unitNumber: u.number, moveInDate: u.move_in_date }));
    const exceptions = computeUtilityExceptions(
      { ...payload, units, nowIso: TODAY_ISO },
      copy,
    );
    const open = exceptions.filter((e) => !e.reviewed);
    const summary = buildUtilitySummary(payload.accounts, payload.currentBills, exceptions, TODAY_ISO);
    const { payables, heldForReviewCount } = buildPayables(
      payload.accounts,
      payload.currentBills,
      exceptions,
      TODAY_ISO,
    );

    const houseAccountIds = new Set(
      payload.accounts.filter((a) => a.isHouseAccount).map((a) => a.id),
    );
    const unitBills: MlgwCurrentBill[] = [];
    const houseBills: MlgwCurrentBill[] = [];
    for (const bill of payload.currentBills) {
      if (bill.accountId && houseAccountIds.has(bill.accountId)) houseBills.push(bill);
      else unitBills.push(bill);
    }
    const sumDue = (bills: MlgwCurrentBill[]) =>
      bills.reduce((sum, b) => sum + Math.max(b.amountDue ?? 0, 0), 0);

    const overview: OverviewData = {
      series: monthlySpendSeries(payload.monthlyTotals),
      mom: monthOverMonth(payload.monthlyTotals),
      unitMix: chargeMixSegments(unitBills),
      houseMix: chargeMixSegments(houseBills),
      unitTotal: sumDue(unitBills),
      houseTotal: sumDue(houseBills),
      topExceptions: open.slice(0, 5),
    };

    const currentMonth = TODAY_ISO.slice(0, 7);
    const reviewedThisMonth = payload.reviews.filter((r) =>
      (r.reviewedAt ?? "").startsWith(currentMonth),
    ).length;

    return {
      payload,
      exceptions,
      open,
      summary,
      payables,
      heldForReviewCount,
      overview,
      openGroups: groupExceptionsByUnit(exceptions, payload.accounts, false),
      allGroups: groupExceptionsByUnit(exceptions, payload.accounts, true),
      bills: billsByAccount(payload.currentBills),
      atRisk: open.reduce((sum, e) => sum + e.amount, 0),
      reviewedThisMonth,
      payableCounts: {
        ready: payables.filter((p) => p.status === "ready").length,
        pastDue: payables.filter((p) => p.status === "past_due").length,
        dueSoon: payables.filter((p) => p.status === "due_soon").length,
      },
    };
  }, [data, allUnits, copy]);

  const onMode = (key: string) => {
    setMode(key as UtilityMode);
    capture("board_mode_switched", { mode: `utilities:${key}` });
  };

  const onToggleReview = (exception: UtilityException, reviewed: boolean) => {
    void useMlgw
      .getState()
      .toggleReview(config, exception.billId, exception.kind, reviewed, exception.accountNumber);
  };

  const modes: BoardMode[] = [
    { key: "overview", label: t("utilities.modes.overview"), icon: "flash-outline" },
    {
      key: "ledger",
      label: t("utilities.modes.ledger"),
      icon: "list-outline",
      count: derived.payload.accounts.length,
    },
    {
      key: "payables",
      label: t("utilities.modes.payables"),
      icon: "card-outline",
      count: derived.payables.length,
    },
    {
      key: "exceptions",
      label: t("utilities.modes.exceptions"),
      icon: "alert-circle-outline",
      count: derived.open.length,
    },
  ];

  const s = derived.summary;
  const metricsByMode: Record<UtilityMode, BoardMetric[]> = {
    overview: [
      {
        value: formatMoneyWhole(s.currentDue),
        tint: "#7A6BC7",
        label: t("utilities.metrics.currentDue"),
        caption: t("utilities.metrics.currentBills", { count: s.currentBillCount }),
        onPress: () => onMode("ledger"),
      },
      {
        value: formatMoneyWhole(s.pastDue),
        tint: "#D1382E",
        label: t("utilities.metrics.pastDue"),
        caption: t("utilities.metrics.pastDueBills", { count: s.pastDueCount }),
        onPress: () => onMode("payables"),
      },
      {
        value: formatMoneyWhole(s.houseSpend),
        tint: "#2563B4",
        label: t("utilities.metrics.houseSpend"),
        caption: t("utilities.metrics.houseAccounts", { count: s.houseAccountCount }),
      },
      {
        value: String(s.spikeCount),
        tint: "#B05E14",
        label: t("utilities.metrics.spikeAlerts"),
        caption: t("utilities.metrics.spikeCaption"),
        onPress: () => onMode("exceptions"),
      },
    ],
    ledger: [
      {
        value: formatMoneyWhole(s.currentDue),
        tint: "#7A6BC7",
        label: t("utilities.metrics.currentDue"),
        caption: t("utilities.metrics.currentBills", { count: s.currentBillCount }),
      },
      {
        value: String(
          derived.payload.accounts.filter((a) => !a.isHouseAccount).length,
        ),
        tint: "#2563B4",
        label: t("utilities.metrics.unitAccounts"),
        caption: t("utilities.metrics.unitAccountsCaption", { count: s.houseAccountCount }),
      },
      {
        value: formatMoneyWhole(s.pastDue),
        tint: "#D1382E",
        label: t("utilities.metrics.pastDue"),
        caption: t("utilities.metrics.pastDueBills", { count: s.pastDueCount }),
        onPress: () => onMode("payables"),
      },
    ],
    payables: [
      {
        value: formatMoneyWhole(derived.payables.reduce((sum, p) => sum + p.amount, 0)),
        tint: "#33A666",
        label: t("utilities.metrics.readyToPay"),
        caption: t("utilities.metrics.readyCaption", { count: derived.payables.length }),
      },
      {
        value: String(derived.payableCounts.pastDue),
        tint: "#D1382E",
        label: t("utilities.metrics.pastDue"),
        caption: t("utilities.metrics.pastDueBills", { count: s.pastDueCount }),
      },
      {
        value: String(derived.payableCounts.dueSoon),
        tint: "#B05E14",
        label: t("utilities.metrics.dueSoon"),
        caption: t("utilities.metrics.dueSoonCaption"),
      },
    ],
    exceptions: [
      {
        value: String(derived.open.length),
        tint: "#B05E14",
        label: t("utilities.metrics.openActions"),
        caption: t("utilities.metrics.unitsFlagged", { count: derived.openGroups.length }),
      },
      {
        value: formatMoneyWhole(derived.atRisk),
        tint: "#D1382E",
        label: t("utilities.metrics.atRisk"),
        caption: t("utilities.metrics.atRiskCaption"),
      },
      {
        value: String(derived.reviewedThisMonth),
        tint: "#33A666",
        label: t("utilities.metrics.reviewed"),
        caption: t("utilities.metrics.reviewedCaption"),
      },
    ],
  };

  const coldLoading = data === null && (loading || !error);

  return (
    <View style={{ flex: 1 }}>
      <BoardHeader
        modes={modes}
        activeMode={mode}
        onMode={onMode}
        metrics={metricsByMode[mode]}
        onHeight={setHeaderH}
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: headerH + 16,
          paddingHorizontal: screenHPad(width),
          paddingBottom: 130,
        }}
      >
        {data === null ? (
          coldLoading ? (
            <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center", gap: 10 }}>
              <ActivityIndicator />
              <Text style={{ fontSize: 12, color: MUTED }}>{t("utilities.loading")}</Text>
            </AppCardSurface>
          ) : (
            <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center", gap: 10 }}>
              <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>
                {t("utilities.loadError")}
              </Text>
              <Pressable
                onPress={() => void useMlgw.getState().load(config)}
                accessibilityRole="button"
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 16,
                  paddingVertical: 7,
                  backgroundColor: "rgba(162,169,33,0.14)",
                  borderWidth: 1,
                  borderColor: "rgba(162,169,33,0.5)",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#767B24" }}>
                  {t("utilities.retry")}
                </Text>
              </Pressable>
            </AppCardSurface>
          )
        ) : mode === "overview" ? (
          <OverviewBoard
            data={derived.overview}
            isWide={isWide}
            locale={locale}
            onSeeExceptions={() => onMode("exceptions")}
          />
        ) : mode === "ledger" ? (
          <LedgerBoard
            accounts={derived.payload.accounts}
            billsForAccount={derived.bills}
            exceptions={derived.exceptions}
            nowIso={TODAY_ISO}
            locale={locale}
          />
        ) : mode === "payables" ? (
          <PayablesBoard
            payables={derived.payables}
            heldForReviewCount={derived.heldForReviewCount}
            locale={locale}
          />
        ) : (
          <ExceptionsBoard
            openGroups={derived.openGroups}
            allGroups={derived.allGroups}
            onToggleReview={onToggleReview}
          />
        )}
      </ScrollView>
    </View>
  );
}

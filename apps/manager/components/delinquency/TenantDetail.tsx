import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { BandHeader, MONEY_COLORS, VERDICT_TONES, Pill } from "@/components/delinquency/bits";
import { fmtMoney, fmtMoneySigned, fmtPercent, fmtShortDate } from "@/components/delinquency/format";
import type { TenantPnl, TimelineItem } from "@/lib/derived/delinquency-view";

/**
 * The tenant sheet body — shared between the phone bottom sheet and the iPad
 * split's right pane: verdict card, P&L waterfall, facts row, the interleaved
 * ledger + action timeline, and the Log action / Record promise buttons.
 */

// ---- waterfall -------------------------------------------------------------

interface WaterfallRow {
  label: string;
  amount: number;
  /** Renders as a negative (cost) line. */
  cost?: boolean;
  color: string;
  /** Left inset of the bar as a share of the track (waterfall stagger). */
  offset: number;
  width: number;
  faded?: boolean;
  suffix?: string;
}

function Waterfall({ rows, net }: { rows: WaterfallRow[]; net: number }) {
  const { t } = useTranslation();
  return (
    <View style={{ marginHorizontal: 18, marginTop: 8 }}>
      {rows.map((row) => (
        <View key={row.label} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
          <Text style={{ width: 92, fontSize: 9.5, fontWeight: "700", color: MONEY_COLORS.slate }}>
            {row.label}
            {row.suffix ? ` · ${row.suffix}` : ""}
          </Text>
          <View style={{ flex: 1, height: 13 }}>
            <View
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${Math.min(97, row.offset * 100)}%`,
                width: `${Math.max(row.amount > 0 ? 2 : 0, Math.min(100, row.width * 100))}%`,
                borderRadius: 4,
                backgroundColor: row.color,
                opacity: row.faded ? 0.35 : 1,
              }}
            />
          </View>
          <Text
            style={{
              width: 70,
              textAlign: "right",
              fontSize: 10.5,
              fontWeight: "800",
              fontVariant: ["tabular-nums"],
              color: row.faded ? MONEY_COLORS.muted : row.color,
            }}
          >
            {row.cost ? fmtMoneySigned(-row.amount) : fmtMoney(row.amount)}
          </Text>
        </View>
      ))}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          borderTopWidth: 1.5,
          borderTopColor: "rgba(9,27,84,0.18)",
          marginTop: 4,
          paddingTop: 6,
        }}
      >
        <Text style={{ flex: 1, fontSize: 10, fontWeight: "800", color: MONEY_COLORS.navy }}>
          {t("delinquency.waterfall.net")}
        </Text>
        <Text
          style={{
            fontSize: 12,
            fontWeight: "800",
            fontVariant: ["tabular-nums"],
            color: net < 0 ? MONEY_COLORS.bad : MONEY_COLORS.pos,
          }}
        >
          {fmtMoneySigned(net)}
        </Text>
      </View>
    </View>
  );
}

// ---- facts row -------------------------------------------------------------

function Fact({ value, label, tint }: { value: string; label: string; tint?: string }) {
  return (
    <View
      style={{
        flex: 1,
        minWidth: 84,
        backgroundColor: "#FFFFFF",
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.08)",
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      <Text style={{ fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"], color: tint ?? MONEY_COLORS.navy }}>
        {value}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: 8.5, fontWeight: "600", color: MONEY_COLORS.muted, marginTop: 1 }}>
        {label}
      </Text>
    </View>
  );
}

// ---- timeline --------------------------------------------------------------

const ACTION_DOT: Record<string, string> = {
  fed_filed: MONEY_COLORS.bad,
  eviction_completed: MONEY_COLORS.bad,
  writeoff: MONEY_COLORS.purple,
};

function TimelineRow({ item }: { item: TimelineItem }) {
  const { t } = useTranslation();
  if (item.type === "ledger") {
    const { entry } = item;
    const isPayment = (entry.credits ?? 0) > 0;
    // Charges read plain ("$1,180"), payments as balance reducers ("−$250").
    const display = isPayment
      ? `−${fmtMoney(entry.credits ?? 0)}`
      : (entry.charges ?? 0) > 0
        ? fmtMoney(entry.charges ?? 0)
        : "—";
    return (
      <View style={rowStyle}>
        <View style={[dotStyle, { backgroundColor: isPayment ? MONEY_COLORS.pos : "rgba(9,27,84,0.35)" }]} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "700", color: MONEY_COLORS.navy }}>
            {entry.description || entry.category || (isPayment ? t("delinquency.timeline.payment") : t("delinquency.timeline.charge"))}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 9, color: MONEY_COLORS.muted, marginTop: 1 }}>
            {fmtShortDate(entry.date)}
            {entry.transactionType ? ` · ${entry.transactionType}` : ""}
          </Text>
        </View>
        <Text
          style={{
            fontSize: 11.5,
            fontWeight: "800",
            fontVariant: ["tabular-nums"],
            color: isPayment ? MONEY_COLORS.pos : MONEY_COLORS.slate,
          }}
        >
          {display}
        </Text>
      </View>
    );
  }
  const { action } = item;
  return (
    <View style={rowStyle}>
      <View style={[dotStyle, { backgroundColor: ACTION_DOT[action.kind] ?? MONEY_COLORS.orange }]} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "700", color: MONEY_COLORS.navy }}>
          {t(`delinquency.kinds.${action.kind}`)}
          {action.note ? ` — ${action.note}` : ""}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 9, color: MONEY_COLORS.muted, marginTop: 1 }}>
          {fmtShortDate(action.createdAt)}
          {action.createdBy ? ` · ${t("delinquency.timeline.by", { name: action.createdBy })}` : ""}
          {action.promiseDueDate ? ` · ${t("delinquency.timeline.dueShort", { date: fmtShortDate(action.promiseDueDate) })}` : ""}
        </Text>
      </View>
      <Text style={{ fontSize: 11.5, fontWeight: "800", fontVariant: ["tabular-nums"], color: MONEY_COLORS.warn }}>
        {typeof action.amount === "number" ? fmtMoney(action.amount) : "—"}
      </Text>
    </View>
  );
}

const rowStyle = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
  paddingVertical: 7,
  borderTopWidth: 1,
  borderTopColor: "rgba(9,27,84,0.07)",
};

const dotStyle = { width: 8, height: 8, borderRadius: 4 };

// ---- body ------------------------------------------------------------------

export function TenantDetailBody({
  pnl,
  balance,
  timesLate,
  timeline,
  loadingLedger,
  ledgerMissing,
  onLogAction,
  onRecordPromise,
}: {
  /** Lifetime P&L when a ledger summary exists for the lease; else null. */
  pnl: TenantPnl | null;
  /** Current balance owed (shown even without a P&L). */
  balance: number;
  timesLate: number;
  timeline: TimelineItem[];
  loadingLedger: boolean;
  /** True when the ledger fetch failed/none exists — timeline is actions-only. */
  ledgerMissing: boolean;
  onLogAction: () => void;
  onRecordPromise: () => void;
}) {
  const { t } = useTranslation();

  const billed = pnl?.billed ?? 0;
  const track = Math.max(billed, 1);
  const w = (v: number) => Math.max(0, v) / track;
  // Costs stagger leftward from the collected edge, waterfall-style.
  const collectedEdge = pnl ? w(pnl.collected) : 0;
  let edge = collectedEdge;
  const costRow = (label: string, amount: number, color: string, suffix?: string): WaterfallRow => {
    const width = w(amount);
    edge = Math.max(0, edge - width);
    return { label, amount, cost: true, color, offset: edge, width, faded: amount === 0, suffix };
  };

  const waterfall: WaterfallRow[] | null = pnl
    ? [
        { label: t("delinquency.waterfall.billed"), amount: pnl.billed, color: "rgba(9,27,84,0.45)", offset: 0, width: 1 },
        { label: t("delinquency.waterfall.collected"), amount: pnl.collected, color: MONEY_COLORS.pos, offset: 0, width: collectedEdge },
        costRow(t("delinquency.waterfall.openBalance"), pnl.openBalance, MONEY_COLORS.bad),
        costRow(t("delinquency.waterfall.concessions"), pnl.concessions, MONEY_COLORS.orange),
        costRow(t("delinquency.waterfall.legal"), pnl.legal, MONEY_COLORS.purple),
        costRow(t("delinquency.waterfall.utility"), pnl.utilityExposure, MONEY_COLORS.info, t("delinquency.sheet.notYetTracked")),
        costRow(t("delinquency.waterfall.maintenance"), pnl.maintenanceEstimate, MONEY_COLORS.warn, t("delinquency.sheet.notYetTracked")),
      ]
    : null;

  return (
    <View>
      {pnl ? (
        <View
          style={{
            marginHorizontal: 18,
            marginTop: 10,
            borderRadius: 14,
            paddingHorizontal: 13,
            paddingVertical: 11,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            backgroundColor: pnl.verdict === "loss" ? "rgba(209,56,46,0.07)" : "rgba(51,166,102,0.07)",
            borderWidth: 1,
            borderColor: pnl.verdict === "loss" ? "rgba(209,56,46,0.25)" : "rgba(51,166,102,0.25)",
          }}
        >
          <View style={{ flex: 1 }}>
            <Text
              style={{
                fontSize: 16,
                fontWeight: "800",
                fontVariant: ["tabular-nums"],
                color: pnl.net < 0 ? MONEY_COLORS.bad : pnl.verdict === "marginal" ? MONEY_COLORS.warn : MONEY_COLORS.pos,
              }}
            >
              {t("delinquency.verdicts.netPosition", { amount: fmtMoneySigned(pnl.net) })}
            </Text>
            <Text style={{ fontSize: 9.5, color: MONEY_COLORS.muted, marginTop: 2, lineHeight: 13 }}>
              {t(`delinquency.verdicts.${pnl.verdict === "loss" ? "lossHint" : pnl.verdict === "marginal" ? "marginalHint" : "profitHint"}`)}
            </Text>
          </View>
          <Pill tone={VERDICT_TONES[pnl.verdict]} label={t(`delinquency.verdicts.${pnl.verdict}`)} />
        </View>
      ) : null}

      {waterfall && pnl ? <Waterfall rows={waterfall} net={pnl.net} /> : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginHorizontal: 18, marginTop: 10 }}>
        <Fact value={fmtMoney(balance)} label={t("delinquency.sheet.balance")} tint={balance > 0 ? MONEY_COLORS.bad : MONEY_COLORS.pos} />
        {pnl ? (
          <Fact
            value={fmtPercent(Math.min(1, pnl.collectionRate), 0)}
            label={t("delinquency.sheet.collectionRate")}
            tint={pnl.collectionRate < 0.9 ? MONEY_COLORS.bad : undefined}
          />
        ) : null}
        <Fact value={`${timesLate}×`} label={t("delinquency.row.timesLate", { count: timesLate })} tint={timesLate >= 3 ? MONEY_COLORS.warn : undefined} />
        {pnl ? <Fact value={String(pnl.monthsOccupied)} label={t("delinquency.sheet.monthsIn")} /> : null}
      </View>

      <BandHeader label={t("delinquency.sheet.ledgerAndActions")} />
      <View style={{ marginHorizontal: 18 }}>
        {loadingLedger ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 }}>
            <ActivityIndicator size="small" />
            <Text style={{ fontSize: 10.5, color: MONEY_COLORS.muted }}>{t("delinquency.sheet.loadingLedger")}</Text>
          </View>
        ) : null}
        {!loadingLedger && ledgerMissing ? (
          <Text style={{ fontSize: 10.5, color: MONEY_COLORS.muted, paddingVertical: 6 }}>
            {t("delinquency.sheet.actionsOnly")}
          </Text>
        ) : null}
        {timeline.map((item) => (
          <TimelineRow key={item.key} item={item} />
        ))}
      </View>

      <View style={{ flexDirection: "row", gap: 8, marginHorizontal: 18, marginTop: 14 }}>
        <Pressable
          onPress={onLogAction}
          accessibilityRole="button"
          style={{
            flex: 1,
            borderRadius: 12,
            paddingVertical: 10,
            alignItems: "center",
            backgroundColor: "rgba(162,169,33,0.92)",
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>{t("delinquency.sheet.logAction")}</Text>
        </Pressable>
        <Pressable
          onPress={onRecordPromise}
          accessibilityRole="button"
          style={{
            flex: 1,
            borderRadius: 12,
            paddingVertical: 10,
            alignItems: "center",
            borderWidth: 1.5,
            borderStyle: "dashed",
            borderColor: "rgba(118,123,36,0.5)",
            backgroundColor: "rgba(162,169,33,0.06)",
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "800", color: MONEY_COLORS.olive }}>
            {t("delinquency.sheet.recordPromise")}
          </Text>
        </Pressable>
      </View>
      <Text style={{ textAlign: "center", fontSize: 10, color: MONEY_COLORS.muted, paddingTop: 12, paddingHorizontal: 16 }}>
        {t("delinquency.footer.actionsOwned")}
      </Text>
    </View>
  );
}

import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { ChargeMixBar } from "@/components/utilities/ChargeMixBar";
import { SectionTitle } from "@/components/utilities/primitives";
import { SpendBarChart } from "@/components/utilities/SpendBarChart";
import type {
  ChargeSegment,
  MonthOverMonth,
  MonthlySpendSeries,
  UtilityException,
} from "@/lib/derived/utility-exceptions";
import {
  formatDeltaPct,
  formatMoney,
  formatMoneyWhole,
  formatMonthLabel,
} from "@/lib/derived/utility-format";
import { HAIRLINE_SOFT, MUTED, NAVY } from "@/theme/tokens";

/**
 * Overview mode: spend trend + current-month mix on the left, month-over-month
 * table + needs-attention feed on the right (mockup "iPad · Utilities —
 * Overview"). On iPad (wide) the two columns sit side by side; on the phone
 * they stack in the same order.
 */
export interface OverviewData {
  series: MonthlySpendSeries;
  mom: MonthOverMonth;
  unitMix: ChargeSegment[];
  houseMix: ChargeSegment[];
  unitTotal: number;
  houseTotal: number;
  topExceptions: UtilityException[];
}

const KIND_ICON: Record<UtilityException["kind"], React.ComponentProps<typeof Ionicons>["name"]> = {
  spike: "flash-outline",
  high_electrical: "flash-outline",
  billed_after_move_in: "document-text-outline",
  balance_forward: "swap-horizontal-outline",
  fee_spike: "pricetag-outline",
  past_due: "alert-circle-outline",
};

function MomRow({
  label,
  current,
  previous,
  delta,
  emphasize,
}: {
  label: string;
  current: string;
  previous: string;
  delta: string;
  emphasize?: boolean;
}) {
  const deltaColor = delta.startsWith("+") ? "#B05E14" : delta.startsWith("−") ? "#33A666" : MUTED;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 7,
        borderTopWidth: 1,
        borderTopColor: HAIRLINE_SOFT,
      }}
    >
      <Text
        style={{
          flex: 1.4,
          fontSize: 11.5,
          fontWeight: emphasize ? "800" : "600",
          color: emphasize ? NAVY : "#4C556F",
        }}
      >
        {label}
      </Text>
      <Text style={cellStyle}>{current}</Text>
      <Text style={cellStyle}>{previous}</Text>
      <Text style={[cellStyle, { color: deltaColor, fontWeight: "800" }]}>{delta}</Text>
    </View>
  );
}

const cellStyle: TextStyle = {
  flex: 1,
  fontSize: 11.5,
  fontWeight: "700",
  color: NAVY,
  textAlign: "right",
  fontVariant: ["tabular-nums"],
};

export function OverviewBoard({
  data,
  isWide,
  locale,
  onSeeExceptions,
}: {
  data: OverviewData;
  isWide: boolean;
  locale: string;
  onSeeExceptions: () => void;
}) {
  const { t } = useTranslation();
  const { series, mom, unitMix, houseMix, unitTotal, houseTotal, topExceptions } = data;

  const spendCard = (
    <AppCardSurface kind="panel" style={{ paddingBottom: 16 }}>
      <SectionTitle>{t("utilities.overview.monthlySpend")}</SectionTitle>
      <View style={{ paddingHorizontal: 16 }}>
        {series.bars.length > 0 ? (
          <>
            <SpendBarChart series={series} monthLabel={(m) => formatMonthLabel(m, locale)} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, marginTop: 8 }}>
              <Text style={{ fontSize: 9.5, fontWeight: "600", color: MUTED }}>
                {t("utilities.overview.averageLegend", {
                  amount: formatMoneyWhole(series.average),
                })}
              </Text>
              {series.bars.some((b) => b.hot) ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: "#D1382E" }} />
                  <Text style={{ fontSize: 9.5, fontWeight: "600", color: MUTED }}>
                    {t("utilities.overview.hotLegend")}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
        ) : (
          <Text style={{ fontSize: 11.5, color: MUTED, lineHeight: 16 }}>
            {t("utilities.overview.noMonthly")}
          </Text>
        )}
      </View>

      <SectionTitle>{t("utilities.overview.currentMix")}</SectionTitle>
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        <Text style={bandLabelStyle}>
          {t("utilities.overview.unitsBand", { amount: formatMoneyWhole(unitTotal) })}
        </Text>
        {unitMix.length > 0 ? (
          <ChargeMixBar segments={unitMix} />
        ) : (
          <Text style={{ fontSize: 10.5, color: MUTED }}>{t("utilities.overview.noMix")}</Text>
        )}
        <Text style={bandLabelStyle}>
          {t("utilities.overview.houseBand", { amount: formatMoneyWhole(houseTotal) })}
        </Text>
        {houseMix.length > 0 ? (
          <ChargeMixBar
            segments={houseMix}
            legendLabel={(s) => t(`utilities.mix.${s.key}`)}
          />
        ) : (
          <Text style={{ fontSize: 10.5, color: MUTED }}>{t("utilities.overview.noMix")}</Text>
        )}
      </View>
    </AppCardSurface>
  );

  const rightCard = (
    <AppCardSurface kind="panel" style={{ paddingBottom: 14 }}>
      <SectionTitle>{t("utilities.overview.monthOverMonth")}</SectionTitle>
      <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingBottom: 4 }}>
        <View style={{ flex: 1.4 }} />
        <Text style={headStyle}>{t("utilities.overview.thisMonth")}</Text>
        <Text style={headStyle}>{t("utilities.overview.lastMonth")}</Text>
        <Text style={headStyle}>{t("utilities.overview.delta")}</Text>
      </View>
      <MomRow
        label={t("utilities.overview.totalSpend")}
        current={formatMoneyWhole(mom.current?.total ?? 0)}
        previous={mom.previous ? formatMoneyWhole(mom.previous.total) : "—"}
        delta={formatDeltaPct(mom.deltaPct)}
        emphasize
      />
      <MomRow
        label={t("utilities.overview.billCount")}
        current={String(mom.current?.billCount ?? 0)}
        previous={mom.previous ? String(mom.previous.billCount) : "—"}
        delta="—"
      />
      <MomRow
        label={t("utilities.overview.unitsRow")}
        current={formatMoneyWhole(unitTotal)}
        previous="—"
        delta="—"
      />
      <MomRow
        label={t("utilities.overview.houseRow")}
        current={formatMoneyWhole(houseTotal)}
        previous="—"
        delta="—"
      />
      <Text style={{ paddingHorizontal: 16, paddingTop: 6, fontSize: 9, color: MUTED }}>
        {t("utilities.overview.thisMonthOnly")}
      </Text>

      <SectionTitle>{t("utilities.overview.needsAttention")}</SectionTitle>
      <View style={{ paddingHorizontal: 16 }}>
        {topExceptions.length === 0 ? (
          <Text style={{ fontSize: 11.5, color: MUTED }}>{t("utilities.overview.allClear")}</Text>
        ) : (
          topExceptions.map((e, i) => (
            <Pressable
              key={e.reviewedKey}
              onPress={onSeeExceptions}
              accessibilityRole="button"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                paddingVertical: 7,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: HAIRLINE_SOFT,
              }}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: "rgba(176,94,20,0.10)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name={KIND_ICON[e.kind]} size={12} color="#B05E14" />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontSize: 11.5, color: "#3A4258" }}>
                  <Text style={{ fontWeight: "800", color: NAVY }}>
                    {e.isHouseAccount ? t("utilities.ledger.house") : e.unitNumber}
                    {" · "}
                    {e.title}
                    {"  "}
                  </Text>
                  {e.detail}
                </Text>
              </View>
              <Text style={{ fontSize: 11.5, fontWeight: "800", color: "#B05E14", fontVariant: ["tabular-nums"] }}>
                {formatMoney(e.amount)}
              </Text>
            </Pressable>
          ))
        )}
        {topExceptions.length > 0 ? (
          <Pressable onPress={onSeeExceptions} accessibilityRole="button" style={{ paddingTop: 8 }}>
            <Text style={{ fontSize: 11, fontWeight: "800", color: "#767B24" }}>
              {t("utilities.overview.seeAll")} ›
            </Text>
          </Pressable>
        ) : null}
      </View>
    </AppCardSurface>
  );

  if (isWide) {
    return (
      <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>{spendCard}</View>
        <View style={{ flex: 1 }}>{rightCard}</View>
      </View>
    );
  }
  return (
    <View style={{ gap: 14 }}>
      {spendCard}
      {rightCard}
    </View>
  );
}

const bandLabelStyle: TextStyle = {
  fontSize: 9.5,
  fontWeight: "800",
  color: MUTED,
  letterSpacing: 0.6,
  textTransform: "uppercase",
};

const headStyle: TextStyle = {
  flex: 1,
  fontSize: 9,
  fontWeight: "700",
  color: MUTED,
  textAlign: "right",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

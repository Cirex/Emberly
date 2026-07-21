import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { AgentStat } from "@emberly/core";
import { BandHeader, Histogram, MONEY_COLORS } from "@/components/delinquency/bits";
import { fmtMoney, fmtMoneyCompact, fmtMonthYear } from "@/components/delinquency/format";
import { FIRST_LATE_DELAY_BUCKETS, type AgentDrillIn } from "@/lib/derived/delinquency-view";

function Fact({ value, label, tint }: { value: string; label: string; tint?: string }) {
  return (
    <View
      style={{
        flex: 1,
        minWidth: 88,
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

/**
 * Agent drill-in body (phone sheet / iPad pane): headline facts, the agent's
 * evictions with first-late context, and the first-late-delay histogram — the
 * screening-quality evidence view.
 */
export function AgentDetailBody({ stat, drill }: { stat: AgentStat; drill: AgentDrillIn }) {
  const { t } = useTranslation();
  return (
    <View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginHorizontal: 18, marginTop: 10 }}>
        <Fact
          value={fmtMoneyCompact(drill.openDelinquent)}
          label={t("delinquency.agents.openDelinquent")}
          tint={drill.openDelinquent > 0 ? MONEY_COLORS.warn : undefined}
        />
        <Fact value={String(drill.delinquentNow)} label={t("delinquency.agents.delinquentNow")} />
        <Fact
          value={String(stat.evictions)}
          label={t("delinquency.metrics.evictions")}
          tint={stat.evictions > 0 ? MONEY_COLORS.bad : undefined}
        />
      </View>

      <BandHeader label={t("delinquency.agents.evictionsBand")} hot={drill.evictions.length > 0} />
      {drill.evictions.length === 0 ? (
        <Text style={{ paddingHorizontal: 18, fontSize: 10.5, color: MONEY_COLORS.muted }}>
          {t("delinquency.agents.noEvictions")}
        </Text>
      ) : (
        drill.evictions.map((ev) => (
          <View
            key={ev.leaseId}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
              paddingVertical: 9,
              paddingHorizontal: 18,
              borderTopWidth: 1,
              borderTopColor: "rgba(9,27,84,0.08)",
            }}
          >
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "800", color: MONEY_COLORS.navy }}>
                {ev.unitNumber} · {t("delinquency.row.evicted")}
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 9, color: MONEY_COLORS.muted, marginTop: 1 }}>
                {[
                  ev.signed ? t("delinquency.agents.signedOn", { date: fmtMonthYear(ev.signed) }) : null,
                  ev.firstLateMonth
                    ? t("delinquency.agents.firstLate", { month: fmtMonthYear(ev.firstLateMonth) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            <Text style={{ fontSize: 12, fontWeight: "800", fontVariant: ["tabular-nums"], color: MONEY_COLORS.bad }}>
              {ev.balance > 0 ? `−${fmtMoney(ev.balance)}` : "—"}
            </Text>
          </View>
        ))
      )}

      <BandHeader label={t("delinquency.agents.pattern")} />
      <View style={{ paddingHorizontal: 18 }}>
        <Histogram values={drill.histogram} labels={FIRST_LATE_DELAY_BUCKETS} height={52} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 5 }}>
          <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: "rgba(122,107,199,0.7)" }} />
          <Text style={{ fontSize: 8.5, fontWeight: "600", color: MONEY_COLORS.muted }}>
            {t("delinquency.agents.histogramLegend")}
          </Text>
        </View>
      </View>

      <Text style={{ textAlign: "center", fontSize: 10, color: MONEY_COLORS.muted, paddingTop: 14, paddingHorizontal: 16 }}>
        {t("delinquency.footer.attribution")}
      </Text>
    </View>
  );
}

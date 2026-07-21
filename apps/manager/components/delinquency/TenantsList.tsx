import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import {
  BandHeader,
  ListFooter,
  MONEY_COLORS,
  Pill,
  SUGGESTION_TONES,
  VERDICT_TONES,
} from "@/components/delinquency/bits";
import { fmtMoneySigned, fmtPercent } from "@/components/delinquency/format";
import type { TenantBands, TenantPnl } from "@/lib/derived/delinquency-view";

function TenantRow({
  pnl,
  selected,
  onPress,
}: {
  pnl: TenantPnl;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const name = pnl.tenantName || (pnl.isCurrentLease ? "" : t("delinquency.row.former"));
  const sub = [
    t("delinquency.row.monthsShort", { count: pnl.monthsOccupied }),
    t("delinquency.row.collectedRate", { rate: fmtPercent(Math.min(1, pnl.collectionRate), 0) }),
    ...(pnl.evicted ? [t("delinquency.row.evicted")] : []),
  ].join(" · ");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingVertical: 11,
        paddingHorizontal: 16,
        borderTopWidth: 1,
        borderTopColor: "rgba(9,27,84,0.08)",
        backgroundColor: selected ? "rgba(162,169,33,0.09)" : "transparent",
      }}
    >
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "800", color: MONEY_COLORS.navy }}>
          {pnl.unitNumber}
          {name ? ` · ${name}` : ""}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 9.5, fontWeight: "600", color: MONEY_COLORS.muted, marginTop: 1 }}>
          {sub}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text
          style={{
            fontSize: 13,
            fontWeight: "800",
            fontVariant: ["tabular-nums"],
            color: pnl.net < 0 ? MONEY_COLORS.bad : pnl.verdict === "marginal" ? MONEY_COLORS.warn : MONEY_COLORS.pos,
          }}
        >
          {fmtMoneySigned(pnl.net)}
        </Text>
        {pnl.suggestion && pnl.verdict === "loss" ? (
          <Pill tone={SUGGESTION_TONES[pnl.suggestion]} label={t(`delinquency.suggestions.${pnl.suggestion}`)} />
        ) : (
          <Pill tone={VERDICT_TONES[pnl.verdict]} label={t(`delinquency.verdicts.${pnl.verdict}`)} />
        )}
      </View>
    </Pressable>
  );
}

/**
 * Tenants mode body: the ranked lifetime-P&L list — deepest losses first,
 * then a small top-performer contrast band, then everyone else.
 */
export function TenantsList({
  bands,
  selectedLeaseId,
  onSelect,
}: {
  bands: TenantBands;
  selectedLeaseId: string | null;
  onSelect: (pnl: TenantPnl) => void;
}) {
  const { t } = useTranslation();
  const groups: { key: string; label: string; rows: TenantPnl[]; hot?: boolean }[] = [
    { key: "losses", label: t("delinquency.bands.losses"), rows: bands.losses, hot: true },
    { key: "top", label: t("delinquency.bands.topPerformers"), rows: bands.topPerformers },
    { key: "rest", label: t("delinquency.bands.others"), rows: bands.rest },
  ];
  const empty = bands.losses.length + bands.topPerformers.length + bands.rest.length === 0;

  return (
    <View>
      {empty ? (
        <ListFooter>{t("delinquency.empty.tenants")}</ListFooter>
      ) : (
        <>
          {groups.map((group) =>
            group.rows.length > 0 ? (
              <Fragment key={group.key}>
                <BandHeader label={group.label} count={group.rows.length} hot={group.hot} />
                {group.rows.map((pnl) => (
                  <TenantRow
                    key={pnl.leaseId}
                    pnl={pnl}
                    selected={pnl.leaseId === selectedLeaseId}
                    onPress={() => onSelect(pnl)}
                  />
                ))}
              </Fragment>
            ) : null,
          )}
          <ListFooter>{t("delinquency.footer.netFormula")}</ListFooter>
        </>
      )}
    </View>
  );
}

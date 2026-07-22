import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { DeltaText, TREND_COLORS } from "@/components/trends/bits";
import type { CompareRow, MonthCompare as MonthCompareData } from "@/lib/derived/trends";

/**
 * "This month vs last" rows (mockup: the Today card "from daily snapshots"):
 * collections rate and delinquent units, each comparing the two months'
 * closing snapshots with a ▲/▼ delta tinted by whether the DIRECTION is good.
 * The mockup's "avg days vacant" row is deliberately absent — see the note in
 * lib/derived/trends.ts (not derivable from one-row-per-day snapshots).
 *
 * Rows that can't answer yet (fewer than two months of data) render nothing;
 * when NO row can answer the caller should hide the whole card.
 */
export function monthCompareHasRows(compare: MonthCompareData): boolean {
  return compare.collections !== null || compare.delinquentUnits !== null;
}

function CompareLine({
  label,
  row,
  formatValue,
  formatDelta,
  tint,
  first,
}: {
  label: string;
  row: CompareRow;
  formatValue: (value: number) => string;
  formatDelta: (abs: number) => string;
  tint: string;
  first: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 7,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: "rgba(9,27,84,0.08)",
      }}
    >
      <Text style={{ flex: 1, fontSize: 10.5, fontWeight: "600", color: TREND_COLORS.muted }}>
        {label}
      </Text>
      <Text
        style={{ fontSize: 12, fontWeight: "800", color: tint, fontVariant: ["tabular-nums"] }}
      >
        {formatValue(row.current)}{" "}
        <DeltaText delta={row.delta} upIsGood={row.upIsGood} format={formatDelta} />
      </Text>
    </View>
  );
}

export function MonthCompare({ compare }: { compare: MonthCompareData }) {
  const { t } = useTranslation();
  const rows: React.ReactNode[] = [];

  if (compare.collections) {
    rows.push(
      <CompareLine
        key="collections"
        first={rows.length === 0}
        label={t("trends.compare.collectionsRate")}
        row={compare.collections}
        formatValue={(v) => `${v.toFixed(1)}%`}
        formatDelta={(abs) => abs.toFixed(1)}
        tint={compare.collections.delta >= 0 ? TREND_COLORS.pos : TREND_COLORS.bad}
      />,
    );
  }
  if (compare.delinquentUnits) {
    rows.push(
      <CompareLine
        key="delinquentUnits"
        first={rows.length === 0}
        label={t("trends.compare.delinquentUnits")}
        row={compare.delinquentUnits}
        formatValue={(v) => String(Math.round(v))}
        formatDelta={(abs) => String(Math.round(abs))}
        tint={compare.delinquentUnits.delta <= 0 ? TREND_COLORS.pos : TREND_COLORS.bad}
      />,
    );
  }

  if (rows.length === 0) return null;
  return <View>{rows}</View>;
}

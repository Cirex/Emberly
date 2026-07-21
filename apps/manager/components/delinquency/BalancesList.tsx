import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import {
  BandHeader,
  ListFooter,
  MONEY_COLORS,
  Pill,
  QuickChip,
  SUGGESTION_TONES,
} from "@/components/delinquency/bits";
import { AgingMeter } from "@/components/delinquency/AgingMeter";
import { fmtMoney, fmtShortDate } from "@/components/delinquency/format";
import type { BalancesBoard, QueueRow } from "@/lib/derived/delinquency-view";

export type BalancesFilter = "all" | "ninetyPlus" | "promise" | "eviction" | "noAction";

function rowMatches(row: QueueRow, filter: BalancesFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "ninetyPlus":
      return row.bucket === "90+";
    case "promise":
      return row.promise !== null && row.promise.state !== "kept";
    case "eviction":
      return row.evicted;
    case "noAction":
      return row.noActionEver;
  }
}

function RowSubtitle({ row }: { row: QueueRow }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (row.bucket) parts.push(row.bucket);
  if (row.unit.timesLate) parts.push(t("delinquency.row.timesLate", { count: row.unit.timesLate ?? 0 }));
  if (row.promise && row.promise.state === "broken") {
    parts.push(t("delinquency.row.promiseBroken", { date: fmtShortDate(row.promise.dueDate) }));
  } else if (row.promise && row.promise.state === "open") {
    parts.push(
      row.promise.amount
        ? t("delinquency.row.promiseBy", {
            amount: fmtMoney(row.promise.amount),
            date: fmtShortDate(row.promise.dueDate),
          })
        : t("delinquency.row.promiseByNoAmount", { date: fmtShortDate(row.promise.dueDate) }),
    );
  } else if (row.lastAction) {
    parts.push(
      t("delinquency.row.lastAction", {
        action: t(`delinquency.kinds.${row.lastAction.kind}`),
        date: fmtShortDate(row.lastAction.createdAt),
      }),
    );
  } else {
    parts.push(t("delinquency.row.noActionLogged"));
  }
  return (
    <Text numberOfLines={1} style={{ fontSize: 9.5, fontWeight: "600", color: MONEY_COLORS.muted, marginTop: 1 }}>
      {parts.join(" · ")}
    </Text>
  );
}

export function BalanceRow({
  row,
  selected,
  onPress,
}: {
  row: QueueRow;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const name = row.unit.tenantNames[0] ?? t("delinquency.row.former");
  const amountColor =
    row.bucket === "90+" || row.evicted || row.promise?.state === "broken"
      ? MONEY_COLORS.bad
      : row.bucket === "31-60" || row.bucket === "61-90"
        ? MONEY_COLORS.warn
        : MONEY_COLORS.slate;
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
          {row.unit.unitNumber} · {name}
        </Text>
        <RowSubtitle row={row} />
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text style={{ fontSize: 13, fontWeight: "800", color: amountColor, fontVariant: ["tabular-nums"] }}>
          {fmtMoney(row.balance)}
        </Text>
        <Pill tone={SUGGESTION_TONES[row.suggestion]} label={t(`delinquency.suggestions.${row.suggestion}`)} />
      </View>
    </Pressable>
  );
}

/**
 * Balances mode body: aging meter, quick-filter chips, then the banded queue
 * (needs action / promise to pay / current cycle). A non-"all" filter
 * flattens to one priority-sorted list.
 */
export function BalancesList({
  board,
  filter,
  onFilter,
  selectedUnitId,
  onSelect,
}: {
  board: BalancesBoard;
  filter: BalancesFilter;
  onFilter: (f: BalancesFilter) => void;
  selectedUnitId: string | null;
  onSelect: (row: QueueRow) => void;
}) {
  const { t } = useTranslation();

  const chips: { key: BalancesFilter; label: string; count: number }[] = [
    { key: "all", label: t("delinquency.chips.all"), count: board.rows.length },
    { key: "ninetyPlus", label: t("delinquency.chips.ninetyPlus"), count: board.ninetyPlusCount },
    { key: "promise", label: t("delinquency.chips.promise"), count: board.promiseCount },
    { key: "eviction", label: t("delinquency.chips.eviction"), count: board.evictionCount },
    { key: "noAction", label: t("delinquency.chips.noAction"), count: board.noActionCount },
  ];

  const bands: { key: keyof BalancesBoard["bands"]; hot?: boolean }[] = [
    { key: "needsAction", hot: true },
    { key: "promise" },
    { key: "currentCycle" },
  ];

  const filtered = board.rows.filter((row) => rowMatches(row, filter));

  return (
    <View>
      <AgingMeter distribution={board.distribution} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 16, paddingTop: 10 }}>
        {chips.map((chip) => (
          <QuickChip
            key={chip.key}
            label={`${chip.label} · ${chip.count}`}
            active={filter === chip.key}
            onPress={() => onFilter(chip.key)}
          />
        ))}
      </View>

      {board.rows.length === 0 ? (
        <ListFooter>{t("delinquency.empty.balances")}</ListFooter>
      ) : filter === "all" ? (
        <>
          {bands.map(({ key, hot }) =>
            board.bands[key].length > 0 ? (
              <Fragment key={key}>
                <BandHeader label={t(`delinquency.bands.${key}`)} count={board.bands[key].length} hot={hot} />
                {board.bands[key].map((row) => (
                  <BalanceRow
                    key={row.unit.unitId}
                    row={row}
                    selected={row.unit.unitId === selectedUnitId}
                    onPress={() => onSelect(row)}
                  />
                ))}
              </Fragment>
            ) : null,
          )}
          <ListFooter>{t("delinquency.footer.priority")}</ListFooter>
        </>
      ) : (
        <>
          <View style={{ height: 8 }} />
          {filtered.map((row) => (
            <BalanceRow
              key={row.unit.unitId}
              row={row}
              selected={row.unit.unitId === selectedUnitId}
              onPress={() => onSelect(row)}
            />
          ))}
          <ListFooter>{t("delinquency.footer.priority")}</ListFooter>
        </>
      )}
    </View>
  );
}

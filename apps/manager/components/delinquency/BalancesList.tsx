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
import { isSilent, type BalancesBoard, type QueueRow } from "@/lib/derived/delinquency-view";

export type BalancesFilter = "all" | "ninetyPlus" | "promise" | "eviction" | "silent";

/**
 * How the queue is grouped. Orthogonal to the filter chips: grouping decides
 * the headers, filtering decides which rows appear under them.
 *
 * "priority" is the collections workflow — what to do next. "tenure" answers a
 * different question: how long has this resident been here? The same 90+
 * balance means something different at three weeks than at five years.
 */
export type BalancesGrouping = "priority" | "tenure";

function rowMatches(row: QueueRow, filter: BalancesFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "ninetyPlus":
      return row.bucket === "90+";
    case "promise":
      return row.promise !== null && row.promise.state !== "kept";
    case "eviction":
      // A ledger filing counts even when the note is blank, which it is on
      // more than half the leases that have one.
      return row.inEviction;
    case "silent":
      return isSilent(row);
  }
}

/**
 * The one-line story under the unit: how old the debt is, then the strongest
 * dated fact we hold about the case.
 *
 * The legal clause comes off the ledger's attorney/court fees rather than the
 * delinquency note, so it appears on all 151 leases with a filing instead of
 * the 68 whose note happens to mention one. The tail is days since the last
 * payment — the honest staleness clock. It replaced "No action logged", which
 * read as "nobody has done anything" on every row on the board, because the
 * actions table it counted has never had a row written to it.
 */
function RowSubtitle({ row }: { row: QueueRow }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (row.bucket) parts.push(row.bucket);
  if (row.unit.timesLate) parts.push(t("delinquency.row.timesLate", { count: row.unit.timesLate ?? 0 }));
  if (row.legal) {
    const filed = t("delinquency.row.fedFiled", { date: fmtShortDate(row.legal.filedDate) });
    parts.push(
      row.legal.servedDate
        ? `${filed} · ${t("delinquency.row.served", { date: fmtShortDate(row.legal.servedDate) })}`
        : filed,
    );
  }
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
  } else if (row.daysSincePayment !== null) {
    parts.push(t("delinquency.row.noPaymentDays", { count: row.daysSincePayment }));
  } else {
    parts.push(t("delinquency.row.neverPaid"));
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
  grouping,
  onGrouping,
  selectedUnitId,
  onSelect,
}: {
  board: BalancesBoard;
  filter: BalancesFilter;
  onFilter: (f: BalancesFilter) => void;
  grouping: BalancesGrouping;
  onGrouping: (g: BalancesGrouping) => void;
  selectedUnitId: string | null;
  onSelect: (row: QueueRow) => void;
}) {
  const { t } = useTranslation();

  const chips: { key: BalancesFilter; label: string; count: number }[] = [
    { key: "all", label: t("delinquency.chips.all"), count: board.rows.length },
    { key: "ninetyPlus", label: t("delinquency.chips.ninetyPlus"), count: board.ninetyPlusCount },
    { key: "promise", label: t("delinquency.chips.promise"), count: board.promiseCount },
    { key: "eviction", label: t("delinquency.chips.eviction"), count: board.evictionCount },
    { key: "silent", label: t("delinquency.chips.silent"), count: board.silentCount },
  ];

  const bands: { key: keyof BalancesBoard["bands"]; hot?: boolean }[] = [
    { key: "needsAction", hot: true },
    { key: "promise" },
    { key: "currentCycle" },
  ];

  const filtered = board.rows.filter((row) => rowMatches(row, filter));
  const tenureGroups = board.tenureGroups
    .map((group) => ({ ...group, rows: group.rows.filter((row) => rowMatches(row, filter)) }))
    .filter((group) => group.rows.length > 0);

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

      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingTop: 8 }}>
        {(["priority", "tenure"] as const).map((key) => (
          <QuickChip
            key={key}
            label={t(`delinquency.grouping.${key}`)}
            active={grouping === key}
            onPress={() => onGrouping(key)}
          />
        ))}
      </View>

      {board.rows.length === 0 ? (
        <ListFooter>{t("delinquency.empty.balances")}</ListFooter>
      ) : grouping === "tenure" ? (
        <>
          {tenureGroups.map((group) => (
            <Fragment key={group.bucket}>
              <BandHeader
                label={t(`delinquency.tenure.${group.bucket}`)}
                count={group.rows.length}
                hot={group.bucket === "0-30" || group.bucket === "31-60"}
              />
              {group.rows.map((row) => (
                <BalanceRow
                  key={row.unit.unitId}
                  row={row}
                  selected={row.unit.unitId === selectedUnitId}
                  onPress={() => onSelect(row)}
                />
              ))}
            </Fragment>
          ))}
          <ListFooter>{t("delinquency.footer.tenure")}</ListFooter>
        </>
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

import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import {
  MONTHS_MISSING_CAP,
  MONTHS_MISSING_CRITICAL,
  MONTHS_MISSING_WARN,
} from "@emberly/core";
import {
  BandHeader,
  BUCKET_COLORS,
  ListFooter,
  MONEY_COLORS,
  Pill,
  QuickChip,
  SUGGESTION_TONES,
} from "@/components/delinquency/bits";
import { AgingMeter } from "@/components/delinquency/AgingMeter";
import { fmtMoney, fmtPercent, fmtShortDate } from "@/components/delinquency/format";
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
 * THE LEDGER BAR — the open balance, what it is made of, and whether it was
 * ever being paid. Transcribed from the approved mockup (.lgr / .lgtop / .lgv
 * / .lgm / .fed / .lgbar / .lgkeys / .lgk).
 *
 * Two ordering rules that look arbitrary and are not:
 *  - segments and their keys stay in CHARGE_BUCKETS order, never sorted by
 *    value, so a category sits in the same place on every row and the eye can
 *    compare down the column. The board-level bar sorts by size instead,
 *    because it has no neighbours to line up with.
 *  - the paid-of-billed key is always last and always present, even at 0%.
 */
function LedgerBar({ row }: { row: QueueRow }) {
  const { t } = useTranslation();
  const b = row.breakdown;
  if (!b) return null;

  const months = b.months;
  const monthsColor =
    months === null
      ? MONEY_COLORS.muted
      : months >= MONTHS_MISSING_CRITICAL
        ? MONEY_COLORS.bad
        : months >= MONTHS_MISSING_WARN
          ? MONEY_COLORS.warn
          : MONEY_COLORS.slate;
  const monthsLabel =
    months === null
      ? t("delinquency.row.rentUnknown")
      : months >= MONTHS_MISSING_CAP
        ? t("delinquency.row.monthsOfRentCapped", { count: MONTHS_MISSING_CAP })
        : t("delinquency.row.monthsOfRent", { count: months.toFixed(1) });

  return (
    <View style={{ marginTop: 7 }}>
      <View
        style={{ flexDirection: "row", alignItems: "baseline", gap: 9, marginBottom: 6, flexWrap: "wrap" }}
      >
        <Text
          style={{
            fontSize: 20,
            fontWeight: "800",
            letterSpacing: -0.6,
            lineHeight: 22,
            color: MONEY_COLORS.navy,
            fontVariant: ["tabular-nums"],
          }}
        >
          {fmtMoney(b.balance)}
        </Text>
        <Text
          style={{
            fontSize: 11.5,
            fontWeight: months === null ? "600" : "700",
            color: monthsColor,
            fontVariant: ["tabular-nums"],
          }}
        >
          {monthsLabel}
        </Text>
        {row.legal ? (
          <Text
            style={{
              marginLeft: "auto",
              fontSize: 9.5,
              fontWeight: "800",
              letterSpacing: 0.3,
              paddingVertical: 2,
              paddingHorizontal: 7,
              borderRadius: 5,
              overflow: "hidden",
              color: MONEY_COLORS.purple,
              backgroundColor: "rgba(122,107,199,0.13)",
            }}
          >
            {t("delinquency.row.fedFiled", { date: fmtShortDate(row.legal.filedDate) })}
          </Text>
        ) : null}
      </View>

      <View
        accessibilityLabel={t("delinquency.row.chargeMix")}
        style={{
          flexDirection: "row",
          height: 11,
          borderRadius: 6,
          overflow: "hidden",
          backgroundColor: "#E3E6ED",
        }}
      >
        {b.slices.map((slice) => (
          <View
            key={slice.bucket}
            style={{ width: `${slice.share * 100}%`, minWidth: 2, backgroundColor: BUCKET_COLORS[slice.bucket] }}
          />
        ))}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 3, columnGap: 13, marginTop: 6 }}>
        {b.slices.map((slice) => (
          <View key={slice.bucket} style={{ flexDirection: "row", alignItems: "center" }}>
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 2,
                marginRight: 5,
                backgroundColor: BUCKET_COLORS[slice.bucket],
              }}
            />
            <Text style={{ fontSize: 10, color: MONEY_COLORS.muted, fontVariant: ["tabular-nums"] }}>
              {t(`delinquency.charges.${slice.bucket}`)}{" "}
              <Text style={{ color: MONEY_COLORS.slate, fontWeight: "700" }}>{fmtMoney(slice.amount)}</Text>
            </Text>
          </View>
        ))}
        <Text
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: MONEY_COLORS.pos,
            fontVariant: ["tabular-nums"],
          }}
        >
          {b.billed > 0
            ? t("delinquency.row.paidOfBilled", {
                paid: fmtMoney(b.paid),
                billed: fmtMoney(b.billed),
                // Deliberately unclamped: an overpaid lease reading 115% is a
                // fact worth seeing, not a rendering error.
                rate: fmtPercent(b.collectionRate, 0),
              })
            : t("delinquency.row.nothingBilled")}
        </Text>
      </View>
    </View>
  );
}

/**
 * The one-line story under the unit: how old the debt is, then the strongest
 * dated fact we hold about the case.
 *
 * The tail is days since the last payment — the honest staleness clock. It
 * replaced "No action logged", which read as "nobody has done anything" on
 * every row on the board, because the actions table it counted has never had a
 * row written to it. The FED filing is not repeated here; the bar badges it.
 */
function RowSubtitle({ row }: { row: QueueRow }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (row.bucket) parts.push(row.bucket);
  if (row.unit.timesLate) parts.push(t("delinquency.row.timesLate", { count: row.unit.timesLate ?? 0 }));
  // The FED filing is NOT repeated here — it has its own badge on the ledger bar.
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
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13.5, fontWeight: "800", color: MONEY_COLORS.navy }}>
            {row.unit.unitNumber} · {name}
          </Text>
          <Pill tone={SUGGESTION_TONES[row.suggestion]} label={t(`delinquency.suggestions.${row.suggestion}`)} />
        </View>
        <RowSubtitle row={row} />
        {row.breakdown ? (
          <LedgerBar row={row} />
        ) : (
          <Text
            style={{
              marginTop: 6,
              fontSize: 17,
              fontWeight: "800",
              color: amountColor,
              fontVariant: ["tabular-nums"],
            }}
          >
            {fmtMoney(row.balance)}
          </Text>
        )}
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

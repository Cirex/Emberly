import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { Chip, StatusPill } from "@/components/utilities/primitives";
import {
  sortPayables,
  type PayableBill,
  type PayableOrder,
} from "@/lib/derived/utility-exceptions";
import {
  accountLast4,
  formatMoney,
  formatMoneyWhole,
  formatShortDate,
} from "@/lib/derived/utility-format";
import { MUTED, NAVY } from "@/theme/tokens";

/**
 * Payables mode: the pay-run list. Status pills (Ready / Past due / Due soon)
 * double as filters, sort-order chips flip between cheapest-first and
 * past-due-first, and bills with an open billed-after-move-in flag are held
 * OUT of the list (the note at the bottom says how many) until their
 * exception is marked reviewed.
 */
export function PayablesBoard({
  payables,
  heldForReviewCount,
  locale,
}: {
  payables: PayableBill[];
  heldForReviewCount: number;
  locale: string;
}) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<PayableOrder>("past_due_first");
  const [statusFilter, setStatusFilter] = useState<PayableBill["status"] | null>(null);

  const counts = { ready: 0, past_due: 0, due_soon: 0 };
  let total = 0;
  for (const p of payables) {
    counts[p.status] += 1;
    total += p.amount;
  }
  const shown = sortPayables(
    statusFilter ? payables.filter((p) => p.status === statusFilter) : payables,
    order,
  );

  const toggleStatus = (s: PayableBill["status"]) =>
    setStatusFilter((cur) => (cur === s ? null : s));

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Chip
          label={t("utilities.payables.ready", { count: counts.ready })}
          selected={statusFilter === "ready"}
          onPress={() => toggleStatus("ready")}
        />
        <Chip
          label={t("utilities.payables.pastDue", { count: counts.past_due })}
          selected={statusFilter === "past_due"}
          onPress={() => toggleStatus("past_due")}
        />
        <Chip
          label={t("utilities.payables.dueSoon", { count: counts.due_soon })}
          selected={statusFilter === "due_soon"}
          onPress={() => toggleStatus("due_soon")}
        />
        <View style={{ flex: 1 }} />
        <Chip
          label={t("utilities.payables.sortLowest")}
          selected={order === "lowest_first"}
          onPress={() => setOrder("lowest_first")}
        />
        <Chip
          label={t("utilities.payables.sortPastDue")}
          selected={order === "past_due_first"}
          onPress={() => setOrder("past_due_first")}
        />
      </View>

      {shown.length === 0 ? (
        <AppCardSurface kind="panel" style={{ padding: 18 }}>
          <Text style={{ fontSize: 12, color: MUTED }}>{t("utilities.payables.empty")}</Text>
        </AppCardSurface>
      ) : (
        <AppCardSurface kind="panel">
          {shown.map((p, i) => (
            <View
              key={p.billId}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                paddingHorizontal: 16,
                paddingVertical: 11,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: "rgba(9,27,84,0.08)",
              }}
            >
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "800", color: NAVY }}>
                  {p.isHouseAccount
                    ? `${t("utilities.ledger.house")} · ${p.serviceAddress}`
                    : `${p.unitNumber} · ${p.serviceAddress}`}
                </Text>
                <Text style={{ fontSize: 10, fontWeight: "600", color: MUTED, marginTop: 1 }}>
                  {t("utilities.ledger.account", { last4: accountLast4(p.accountNumber) })}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 3 }}>
                <Text style={{ fontSize: 13, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}>
                  {formatMoney(p.amount)}
                </Text>
                {p.status === "past_due" ? (
                  <StatusPill tone="late" label={t("utilities.payables.statusPastDue")} />
                ) : p.status === "due_soon" ? (
                  <StatusPill
                    tone="soon"
                    label={t("utilities.payables.statusDueSoon", {
                      date: formatShortDate(p.dueDate, locale),
                    })}
                  />
                ) : (
                  <StatusPill
                    tone="good"
                    label={
                      p.dueDate
                        ? t("utilities.payables.statusDueSoon", {
                            date: formatShortDate(p.dueDate, locale),
                          })
                        : t("utilities.payables.statusReady")
                    }
                  />
                )}
              </View>
            </View>
          ))}
        </AppCardSurface>
      )}

      <Text style={{ fontSize: 10.5, fontWeight: "700", color: MUTED, textAlign: "center" }}>
        {t("utilities.payables.total", { amount: formatMoneyWhole(total) })}
      </Text>
      {heldForReviewCount > 0 ? (
        <Text style={{ fontSize: 10, fontWeight: "700", color: "#B05E14", textAlign: "center" }}>
          {t("utilities.payables.heldForReview", { count: heldForReviewCount })}
        </Text>
      ) : null}
    </View>
  );
}

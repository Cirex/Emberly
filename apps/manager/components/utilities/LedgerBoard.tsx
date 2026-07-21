import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { ChargeMixBar } from "@/components/utilities/ChargeMixBar";
import { Chip, StatusPill } from "@/components/utilities/primitives";
import type { MlgwAccount, MlgwCurrentBill } from "@/lib/api/mlgw";
import {
  chargeMixSegments,
  type UtilityException,
} from "@/lib/derived/utility-exceptions";
import {
  accountLast4,
  formatMoney,
  formatShortDate,
} from "@/lib/derived/utility-format";
import { HAIRLINE_SOFT, MUTED, NAVY } from "@/theme/tokens";

/**
 * Ledger mode: one row per MLGW account (mockup "iPhone · Ledger"), expandable
 * into its charge-mix bar, a recent-bills mini table, and a billed-after-
 * move-in warning when Exceptions flagged one of its bills. Charge columns
 * degrade to "—" when the PDF-extraction seam gave us nothing.
 */
export function LedgerBoard({
  accounts,
  billsForAccount,
  exceptions,
  nowIso,
  locale,
}: {
  accounts: MlgwAccount[];
  billsForAccount: Map<string, MlgwCurrentBill[]>;
  exceptions: UtilityException[];
  nowIso: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"units" | "house" | "all">("units");
  const [expanded, setExpanded] = useState<string | null>(null);

  const unitAccounts = accounts.filter((a) => !a.isHouseAccount);
  const houseAccounts = accounts.filter((a) => a.isHouseAccount);
  const shown =
    filter === "units" ? unitAccounts : filter === "house" ? houseAccounts : accounts;

  const moveInFlagged = new Map<string, UtilityException>();
  for (const e of exceptions) {
    if (e.kind === "billed_after_move_in" && !e.reviewed) moveInFlagged.set(e.billId, e);
  }

  const today = nowIso.slice(0, 10);
  const money = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? formatMoney(v) : "—";

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip
          label={t("utilities.ledger.chipUnits", { count: unitAccounts.length })}
          selected={filter === "units"}
          onPress={() => setFilter("units")}
        />
        <Chip
          label={t("utilities.ledger.chipHouse", { count: houseAccounts.length })}
          selected={filter === "house"}
          onPress={() => setFilter("house")}
        />
        <Chip
          label={t("utilities.ledger.chipAll", { count: accounts.length })}
          selected={filter === "all"}
          onPress={() => setFilter("all")}
        />
      </View>

      {shown.length === 0 ? (
        <AppCardSurface kind="panel" style={{ padding: 18 }}>
          <Text style={{ fontSize: 12, color: MUTED }}>{t("utilities.empty")}</Text>
        </AppCardSurface>
      ) : (
        <AppCardSurface kind="panel">
          {shown.map((account, i) => {
            const bills = billsForAccount.get(account.id) ?? [];
            const isOpen = expanded === account.id;
            const dueNow = account.dueNow ?? 0;
            const dueDate = (account.dueDate ?? "").slice(0, 10);
            const pastDue = dueNow > 0 && dueDate !== "" && dueDate < today;
            const flagged = bills.map((b) => moveInFlagged.get(b.id)).find(Boolean);
            const mix = chargeMixSegments(bills);
            const title = account.isHouseAccount
              ? `${t("utilities.ledger.house")} · ${account.serviceAddress}`
              : `${account.unitNumber} · ${account.serviceAddress}`;

            return (
              <View
                key={account.id}
                style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: "rgba(9,27,84,0.08)" }}
              >
                <Pressable
                  onPress={() => setExpanded(isOpen ? null : account.id)}
                  accessibilityRole="button"
                  accessibilityState={isOpen ? { expanded: true } : { expanded: false }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 9,
                    paddingHorizontal: 16,
                    paddingVertical: 11,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "800", color: NAVY }}>
                      {title}
                    </Text>
                    <Text style={{ fontSize: 10, fontWeight: "600", color: MUTED, marginTop: 1 }}>
                      {t("utilities.ledger.account", { last4: accountLast4(account.accountNumber) })}
                      {" · "}
                      {t("utilities.ledger.billsOnFile", { count: bills.length })}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 3 }}>
                    <Text style={{ fontSize: 13, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}>
                      {formatMoney(dueNow)}
                    </Text>
                    {pastDue ? (
                      <StatusPill tone="late" label={t("utilities.ledger.pastDuePill")} />
                    ) : dueNow > 0 && dueDate ? (
                      <StatusPill
                        tone="soon"
                        label={t("utilities.ledger.duePill", {
                          date: formatShortDate(dueDate, locale),
                        })}
                      />
                    ) : (
                      <StatusPill tone="neutral" label={t("utilities.ledger.noDuePill")} />
                    )}
                  </View>
                </Pressable>

                {isOpen ? (
                  <View
                    style={{
                      paddingHorizontal: 16,
                      paddingBottom: 12,
                      borderTopWidth: 1,
                      borderTopColor: HAIRLINE_SOFT,
                      paddingTop: 10,
                      gap: 8,
                    }}
                  >
                    {mix.length > 0 ? (
                      <ChargeMixBar
                        segments={mix}
                        height={10}
                        legendLabel={(s) => `${t(`utilities.mix.${s.key}`)} ${formatMoney(s.amount)}`}
                      />
                    ) : (
                      <Text style={{ fontSize: 10.5, color: MUTED }}>
                        {t("utilities.overview.noMix")}
                      </Text>
                    )}

                    {bills.length > 0 ? (
                      <View>
                        <View style={{ flexDirection: "row", paddingBottom: 4 }}>
                          <Text style={[thStyle, { flex: 1.5, textAlign: "left" }]}>
                            {t("utilities.ledger.billHeader")}
                          </Text>
                          <Text style={thStyle}>{t("utilities.ledger.amountHeader")}</Text>
                          <Text style={thStyle}>{t("utilities.ledger.electricHeader")}</Text>
                          <Text style={thStyle}>{t("utilities.ledger.waterHeader")}</Text>
                          <Text style={thStyle}>{t("utilities.ledger.balFwdHeader")}</Text>
                        </View>
                        {bills.map((bill, bi) => (
                          <View
                            key={bill.id}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              paddingVertical: 5,
                              borderTopWidth: 1,
                              borderTopColor: HAIRLINE_SOFT,
                            }}
                          >
                            <View style={{ flex: 1.5, flexDirection: "row", alignItems: "center", gap: 5 }}>
                              {bi === 0 ? (
                                <StatusPill tone="blue" label={t("utilities.ledger.currentTag")} />
                              ) : null}
                              <Text style={{ fontSize: 11, fontWeight: "700", color: NAVY }}>
                                {formatShortDate(bill.billDate, locale) || "—"}
                              </Text>
                            </View>
                            <Text style={tdStyle}>{money(bill.amountDue)}</Text>
                            <Text style={[tdStyle, (bill.electricTotal ?? 0) > 0 ? { color: "#B05E14" } : null]}>
                              {money(bill.electricTotal)}
                            </Text>
                            <Text style={tdStyle}>{money(bill.waterTotal)}</Text>
                            <Text style={tdStyle}>{money(bill.balanceForward)}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}

                    {flagged ? (
                      <Text style={{ fontSize: 10, fontWeight: "800", color: "#B05E14" }}>
                        ⚠{" "}
                        {t("utilities.ledger.afterMoveInWarning", {
                          date:
                            formatShortDate(flagged.context.moveInDate, locale) ||
                            formatShortDate(flagged.context.billDate, locale),
                        })}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </AppCardSurface>
      )}
      <Text style={{ fontSize: 10, color: MUTED, textAlign: "center" }}>
        {t("utilities.ledger.footer")}
      </Text>
    </View>
  );
}

const thStyle: TextStyle = {
  flex: 1,
  fontSize: 8.5,
  fontWeight: "700",
  color: MUTED,
  textAlign: "right",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const tdStyle: TextStyle = {
  flex: 1,
  fontSize: 11,
  fontWeight: "700",
  color: NAVY,
  textAlign: "right",
  fontVariant: ["tabular-nums"],
};

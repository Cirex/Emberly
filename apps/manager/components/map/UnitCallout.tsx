import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { agingBucket } from "@emberly/core";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import type { ResmanUnit } from "@/lib/api/units";
import { activeLocale } from "@/lib/i18n";

const withAlpha = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function money(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
}

function shortDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(activeLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The manager's unit callout, anchored at the tapped unit (mockup's heat-lens
 * card): unit + tenants in the header, then balance / aging / lease-end facts,
 * and the "Open tenant" action. Ported from maintenance's UnitTooltipCard
 * shape, trimmed of the tag editor; the lens tint drives the accent stripe.
 *
 * "Open tenant" is a stub in v1 — the delinquency-detail cross-nav lands with
 * the tenant sheet; today it only fires analytics (see the screen).
 *
 * Aging derives from the delinquency-with-aging columns on the units mirror
 * (current/last/period/previous month balances), so the bucket reflects how
 * old the debt actually is, not just that it exists.
 */
export function UnitCallout({
  unit,
  data,
  tint,
  onOpenTenant,
}: {
  unit: { number: string };
  data?: ResmanUnit;
  tint: string;
  onOpenTenant: () => void;
}) {
  const { t } = useTranslation();

  const locality = [data?.city?.trim(), data?.state?.trim()].filter(Boolean).join(", ");
  const subline = [unit.number, locality].filter(Boolean).join(" · ");
  const occupant = data
    ? data.tenant_names.length
      ? data.tenant_names.join(", ")
      : t("map.callout.unoccupied")
    : "—";
  const balance = typeof data?.balance === "number" ? data.balance : null;
  const bucket = data
    ? agingBucket({
        currentMonthBalance: data.current_month_balance,
        lastMonthBalance: data.last_month_balance,
        periodBalance: data.period_balance,
        previousBalance: data.previous_balance,
        balance: data.balance,
      })
    : null;
  const owes = balance !== null && balance > 0;

  return (
    <AppCardSurface
      kind="panel"
      style={{
        width: 250,
        overflow: "hidden",
        shadowColor: "#000",
        shadowOpacity: 0.22,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 10 },
      }}
    >
      {/* Leading accent stripe, tinted by the active lens. */}
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: tint, zIndex: 2 }}
      />

      {/* Header: icon disc + address + occupant line. */}
      <View
        className="flex-row items-start"
        style={{ gap: 10, paddingVertical: 12, paddingLeft: 15, paddingRight: 13 }}
      >
        <View
          className="items-center justify-center"
          style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: withAlpha(tint, 0.16) }}
        >
          <Ionicons name="business" size={16} color={tint} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 13, fontWeight: "800", letterSpacing: -0.2 }}
            numberOfLines={1}
          >
            {data?.street?.trim() || unit.number}
          </Text>
          <Text
            className="text-slate dark:text-white/55"
            style={{ fontSize: 11, fontWeight: "600" }}
            numberOfLines={1}
          >
            {subline}
          </Text>
          <Text
            className="text-navy dark:text-white/85"
            style={{ fontSize: 11, fontWeight: "700", marginTop: 3 }}
            numberOfLines={2}
          >
            {data ? occupant : t("map.callout.noData")}
          </Text>
        </View>
      </View>

      {/* Fact rows: balance / aging / lease end. */}
      <View
        style={{
          marginHorizontal: 15,
          borderRadius: 12,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: "rgba(9,27,84,0.10)",
        }}
      >
        <FactRow
          k={t("map.callout.balance")}
          v={balance !== null ? money(balance) : "—"}
          vColor={owes ? "#D1382E" : undefined}
        />
        <FactRow
          k={t("map.callout.aging")}
          v={bucket ? t("map.callout.pastDue", { bucket }) : data ? t("map.callout.current") : "—"}
          border
        />
        <FactRow
          k={t("map.callout.leaseEnds")}
          v={data?.lease_end_date ? shortDate(data.lease_end_date) : "—"}
          border
        />
      </View>

      {/* "Open tenant" — the delinquency/tenant cross-nav stub. */}
      <View style={{ paddingHorizontal: 15, paddingTop: 12, paddingBottom: 14 }}>
        <Pressable
          onPress={onOpenTenant}
          accessibilityRole="button"
          className="flex-row items-center justify-center"
          style={{
            gap: 4,
            borderRadius: 10,
            paddingVertical: 8,
            backgroundColor: "rgba(162,169,33,0.92)",
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>
            {t("map.callout.openTenant")}
          </Text>
          <Ionicons name="chevron-forward" size={12} color="#FFFFFF" />
        </Pressable>
      </View>
    </AppCardSurface>
  );
}

/** One fact row — uppercase key on the left, bold value on the right. */
function FactRow({ k, v, vColor, border }: { k: string; v: string; vColor?: string; border?: boolean }) {
  return (
    <View
      className="flex-row items-center"
      style={{
        paddingVertical: 7,
        paddingHorizontal: 11,
        gap: 8,
        backgroundColor: "rgba(246,244,235,0.45)",
        borderTopWidth: border ? 1 : 0,
        borderTopColor: "rgba(9,27,84,0.10)",
      }}
    >
      <Text
        className="text-slate dark:text-white/50"
        style={{ flex: 1, fontSize: 9, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}
      >
        {k}
      </Text>
      {vColor ? (
        <Text style={{ fontSize: 12, fontWeight: "700", color: vColor }} numberOfLines={1}>
          {v}
        </Text>
      ) : (
        <Text className="text-navy dark:text-white" style={{ fontSize: 12, fontWeight: "700" }} numberOfLines={1}>
          {v}
        </Text>
      )}
    </View>
  );
}

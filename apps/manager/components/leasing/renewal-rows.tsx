import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StatusPill } from "@/components/leasing/primitives";
import { formatDay } from "@/components/leasing/rows";
import { signedMoney } from "@/lib/derived/leasing";
import type { NeedsOfferRow, OfferSentRow, ResolvedRow } from "@/lib/derived/renewals-view";
import type { RenewalOffer } from "@/lib/api/renewals";
import { parseDay } from "@/lib/derived/time";
import { HAIRLINE, MUTED } from "@/theme/tokens";

/**
 * Row renderers for the Renewals mode — the mockup's three band anatomies:
 * needs-offer ("0327 · Reyes / Ends Jul 31 · $1,240 now · mark +$95" with the
 * days-left pill and "Draft offer ›"), offer-sent ("Offered $1,310 · 14 mo ·
 * sent Jul 10" with Silent/Sent pills), and resolved (accepted with the lift
 * chip; declined with "Pre-lease this unit"). All math arrives prederived
 * from lib/derived/renewals-view.ts.
 */

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/** "14 mo" / "MTM" for an offer's term. */
export function useOfferTermLabel(): (offer: RenewalOffer) => string {
  const { t } = useTranslation();
  return (offer) =>
    offer.isMonthToMonth || offer.termMonths === null || offer.termMonths === undefined
      ? t("leasing.renewals.row.termMtm")
      : t("leasing.renewals.row.termMonths", { count: offer.termMonths });
}

function Shell({
  children,
  last,
  onPress,
}: {
  children: React.ReactNode;
  last: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: HAIRLINE,
      }}
    >
      {children}
    </Pressable>
  );
}

function BigLine({ text }: { text: string }) {
  return (
    <Text
      className="text-navy dark:text-white"
      numberOfLines={1}
      style={{ fontSize: 13.5, fontWeight: "800", letterSpacing: -0.2 }}
    >
      {text}
    </Text>
  );
}

function SubLine({ text }: { text: string }) {
  return (
    <Text numberOfLines={1} style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
      {text}
    </Text>
  );
}

function titleOf(unitNumber: string, tenantName: string): string {
  return tenantName ? `${unitNumber} · ${tenantName}` : unitNumber || "—";
}

export function NeedsOfferRowView({
  row,
  last,
  onPress,
}: {
  row: NeedsOfferRow;
  last: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { lease } = row.expiration;
  const subParts = [
    lease.residentRent !== null && lease.residentRent !== undefined
      ? t("leasing.renewals.row.endsNow", {
          date: formatDay(row.expiration.endMs),
          rent: money(lease.residentRent),
        })
      : t("leasing.row.endsOn", { date: formatDay(row.expiration.endMs) }),
    row.expiration.markToMarket !== null
      ? t("leasing.renewals.row.mark", { amount: signedMoney(row.expiration.markToMarket) })
      : "",
  ].filter(Boolean);
  return (
    <Shell last={last} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <BigLine text={titleOf(lease.unitNumber, row.expiration.tenantName)} />
        <SubLine text={subParts.join(" · ")} />
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <StatusPill
          label={
            row.urgent
              ? t("leasing.renewals.row.daysLeftPill", { count: row.expiration.daysLeft })
              : t("leasing.row.daysLeft", { count: row.expiration.daysLeft })
          }
          tone={row.urgent ? "late" : "soon"}
        />
        <SubLine text={t("leasing.renewals.row.draftOffer")} />
      </View>
    </Shell>
  );
}

export function OfferSentRowView({
  row,
  last,
  onPress,
}: {
  row: OfferSentRow;
  last: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const termLabel = useOfferTermLabel();
  const unitNumber = row.lease?.unitNumber || row.offer.unitNumber;
  return (
    <Shell last={last} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <BigLine text={titleOf(unitNumber, row.tenantName)} />
        <SubLine
          text={t("leasing.renewals.row.offered", {
            rent: money(row.offer.proposedRent),
            term: termLabel(row.offer),
            date: row.sentMs !== null ? formatDay(row.sentMs) : "—",
          })}
        />
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <StatusPill
          label={
            row.silent
              ? t("leasing.renewals.row.silentPill", { days: row.daysSinceSent })
              : t("leasing.renewals.row.sentPill", { days: row.daysSinceSent })
          }
          tone={row.silent ? "soon" : "blue"}
        />
        {row.silent ? <SubLine text={t("leasing.renewals.row.silentHint")} /> : null}
      </View>
    </Shell>
  );
}

export function ResolvedRowView({
  row,
  last,
  onPress,
}: {
  row: ResolvedRow;
  last: boolean;
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const termLabel = useOfferTermLabel();
  const unitNumber = row.lease?.unitNumber || row.offer.unitNumber;
  const moveOutMs = row.lease ? parseDay(row.lease.moveOutDate) : null;

  const sub = row.accepted
    ? typeof row.offer.priorRent === "number"
      ? t("leasing.renewals.row.acceptedSub", {
          rent: money(row.offer.proposedRent),
          term: termLabel(row.offer),
          prior: money(row.offer.priorRent),
        })
      : t("leasing.renewals.row.acceptedSubNoPrior", {
          rent: money(row.offer.proposedRent),
          term: termLabel(row.offer),
        })
    : moveOutMs !== null
      ? t("leasing.renewals.row.declinedSub", { date: formatDay(moveOutMs) })
      : t("leasing.renewals.row.declinedSubNoDate");

  return (
    <Shell last={last} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <BigLine text={titleOf(unitNumber, row.tenantName)} />
        <SubLine text={sub} />
      </View>
      <View style={{ alignItems: "flex-end" }}>
        {row.accepted && row.lift !== null ? (
          <StatusPill
            label={t("leasing.renewals.row.liftPill", { amount: signedMoney(row.lift) })}
            tone="good"
          />
        ) : row.accepted ? (
          <StatusPill label={t("leasing.renewals.chips.accepted")} tone="good" />
        ) : (
          <StatusPill label={t("leasing.row.preLease")} tone="neutral" />
        )}
      </View>
    </Shell>
  );
}

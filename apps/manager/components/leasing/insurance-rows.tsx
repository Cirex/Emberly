import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StatusPill } from "@/components/leasing/primitives";
import { formatDay } from "@/components/leasing/rows";
import { shortMoney } from "@/lib/derived/leasing";
import type { InsuranceRowView } from "@/lib/derived/insurance-view";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED } from "@/theme/tokens";

/**
 * Row renderers for the Compliance mode — the mockup's three band anatomies:
 * lapsed ("0731 · Sanders / Allstate · expired Apr 2 · 110 days" with the
 * red $0 and the Request proof / Requested Nd ago chip), expiring ("State
 * Farm ···4471 · ends Jul 30" with the coverage money and countdown pill),
 * and never filed ("No policy on file since move-in Mar 2025" — its own
 * band, deliberately separate from lapsed). All math arrives prederived from
 * lib/derived/insurance-view.ts.
 */

/** "Mar 2025" in the active locale — the never-filed move-in context. */
export function formatMonthYearShort(ms: number): string {
  return new Date(ms).toLocaleDateString(activeLocale(), { month: "short", year: "numeric" });
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

function titleOf(row: InsuranceRowView): string {
  const unit = row.policy.unitNumber;
  return row.tenantName ? `${unit} · ${row.tenantName}` : unit || "—";
}

/** "State Farm ···4471" (provider alone when the number is unknown). */
function providerLine(row: InsuranceRowView): string {
  const provider = row.policy.provider ?? "";
  const last4 = row.policy.policyNumberLast4 ?? "";
  return last4 ? `${provider} ···${last4}`.trim() : provider;
}

export function LapsedRowView({
  row,
  last,
  onPress,
}: {
  row: InsuranceRowView;
  last: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const subParts = [
    row.policy.provider ?? "",
    row.endMs !== null ? t("leasing.compliance.row.expiredOn", { date: formatDay(row.endMs) }) : "",
    row.daysSinceLapse !== null
      ? t("leasing.compliance.row.days", { count: row.daysSinceLapse })
      : "",
  ].filter(Boolean);
  return (
    <Shell last={last} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <BigLine text={titleOf(row)} />
        {subParts.length > 0 ? <SubLine text={subParts.join(" · ")} /> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text
          style={{
            fontSize: 12,
            fontWeight: "800",
            color: "#D1382E",
            fontVariant: ["tabular-nums"],
          }}
        >
          $0
        </Text>
        {row.lastProofRequest !== null ? (
          <StatusPill
            label={t("leasing.compliance.row.requestedAgo", { days: row.daysSinceRequest ?? 0 })}
            tone="soon"
          />
        ) : (
          <StatusPill label={t("leasing.compliance.row.requestProof")} tone="late" />
        )}
      </View>
    </Shell>
  );
}

export function ExpiringRowView({
  row,
  last,
  onPress,
}: {
  row: InsuranceRowView;
  last: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const subParts = [
    providerLine(row),
    row.endMs !== null ? t("leasing.compliance.row.endsOn", { date: formatDay(row.endMs) }) : "",
  ].filter(Boolean);
  return (
    <Shell last={last} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <BigLine text={titleOf(row)} />
        {subParts.length > 0 ? <SubLine text={subParts.join(" · ")} /> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        {row.policy.coverageAmount !== null && row.policy.coverageAmount !== undefined ? (
          <Text
            style={{
              fontSize: 12,
              fontWeight: "800",
              color: "#4C556F",
              fontVariant: ["tabular-nums"],
            }}
          >
            {shortMoney(row.policy.coverageAmount)}
          </Text>
        ) : null}
        <StatusPill
          label={t("leasing.compliance.row.days", { count: row.daysLeft ?? 0 })}
          tone="soon"
        />
      </View>
    </Shell>
  );
}

export function NeverFiledRowView({
  row,
  last,
  onPress,
}: {
  row: InsuranceRowView;
  last: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const sub =
    row.leaseStartMs !== null
      ? t("leasing.compliance.row.neverFiledSince", {
          date: formatMonthYearShort(row.leaseStartMs),
        })
      : t("leasing.compliance.row.neverFiledNoDate");
  return (
    <Shell last={last} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <BigLine text={titleOf(row)} />
        <SubLine text={sub} />
      </View>
      <StatusPill label={t("leasing.compliance.row.neverFiledPill")} tone="neutral" />
    </Shell>
  );
}

/**
 * The four-segment coverage distribution — the mockup's `.cov` bar ported to
 * plain Views: proportional colored segments plus a wrapped legend with live
 * counts (labels move to a legend so a 4% segment can't squash its text).
 */
export function CoverageBar({
  covered,
  expiring,
  lapsed,
  none,
}: {
  covered: number;
  expiring: number;
  lapsed: number;
  none: number;
}) {
  const { t } = useTranslation();
  const segments = [
    { key: "covered", count: covered, color: "#33A666", labelKey: "leasing.compliance.cov.covered" },
    { key: "expiring", count: expiring, color: "#E38736", labelKey: "leasing.compliance.cov.expiring" },
    { key: "lapsed", count: lapsed, color: "#D1382E", labelKey: "leasing.compliance.cov.lapsed" },
    { key: "none", count: none, color: "rgba(9,27,84,0.25)", labelKey: "leasing.compliance.cov.none" },
  ];
  const total = covered + expiring + lapsed + none;
  if (total === 0) return null;
  return (
    <View style={{ paddingVertical: 6 }}>
      <View style={{ flexDirection: "row", height: 12, borderRadius: 6, overflow: "hidden" }}>
        {segments.map((s) =>
          s.count > 0 ? (
            <View key={s.key} style={{ flex: s.count, backgroundColor: s.color }} />
          ) : null,
        )}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
        {segments.map((s) => (
          <View key={s.key} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
            <Text
              style={{
                fontSize: 9.5,
                fontWeight: "700",
                color: MUTED,
                fontVariant: ["tabular-nums"],
              }}
            >
              {t(s.labelKey, { count: s.count })}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

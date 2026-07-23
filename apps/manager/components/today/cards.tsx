import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { BarColumns, BarLegend } from "@/components/leasing/BarColumns";
import { StatusPill } from "@/components/leasing/primitives";
import { formatDay } from "@/components/leasing/rows";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import {
  signedMoney,
  type ExpirationRow,
  type FeedEvent,
  type FeedKind,
  type MonthlyFlow,
} from "@/lib/derived/leasing";
import { calendarDaysBetween } from "@/lib/derived/time";
import type { MakeReadySnapshot } from "@/lib/derived/work-boards";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED, NAVY, OLIVE_GLASS } from "@/theme/tokens";

/**
 * The Today board's cards — mockup's `.card` anatomy: bold title, muted
 * caption, an optional "go ›" affordance, then feed rows / a chart. Pure
 * presenters; the screen derives everything and passes it down.
 */

// ── Card shell ──────────────────────────────────────────────────────────────

export function TodayCard({
  title,
  caption,
  goLabel,
  onGo,
  children,
}: {
  title: string;
  caption?: string;
  goLabel?: string;
  onGo?: () => void;
  children: ReactNode;
}) {
  return (
    <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 13 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "800", letterSpacing: -0.2 }}>
          {title}
        </Text>
        {caption ? (
          <Text className="text-muted dark:text-white/50" style={{ fontSize: 10.5 }}>
            {caption}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        {goLabel && onGo ? (
          <Pressable onPress={onGo} accessibilityRole="button" hitSlop={8}>
            <Text style={{ fontSize: 11, fontWeight: "800", color: OLIVE_GLASS }}>{goLabel} ›</Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </AppCardSurface>
  );
}

// ── Feed (Today's flow) ─────────────────────────────────────────────────────

const FEED_ICON: Record<FeedKind, { icon: React.ComponentProps<typeof Ionicons>["name"]; bg: string; fg: string }> = {
  moveIn: { icon: "home", bg: "rgba(51,166,102,0.14)", fg: "#1F7A47" },
  application: { icon: "document-text", bg: "rgba(37,99,180,0.12)", fg: "#2563B4" },
  signed: { icon: "create", bg: "rgba(122,107,199,0.16)", fg: "#5B4BA8" },
  moveOut: { icon: "cube", bg: "rgba(227,135,54,0.16)", fg: "#B05E14" },
};

/** "Today" / "Yesterday" / "3d ago" / "in 12d" / short date. */
function feedTimeLabel(
  whenMs: number,
  nowMs: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const days = calendarDaysBetween(whenMs, nowMs); // positive = past
  if (days === 0) return t("today.time.today");
  if (days === 1) return t("today.time.yesterday");
  if (days > 1 && days <= 13) return t("today.time.daysAgo", { count: days });
  if (days < 0 && days >= -13) return t("today.time.inDays", { count: -days });
  return new Date(whenMs).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
}

function feedTitle(event: FeedEvent, t: (key: string, params?: Record<string, unknown>) => string): string {
  const who = event.tenantName
    ? `${event.tenantName} → ${event.unitNumber}`
    : event.unitNumber || "—";
  switch (event.kind) {
    case "moveIn":
      return t("today.feed.moveIn", { who });
    case "application":
      return t("today.feed.application", { unit: event.unitNumber || "—" });
    case "signed":
      return t("today.feed.signed", { who });
    case "moveOut":
      return event.scheduled
        ? t("today.feed.moveOutScheduled", { unit: event.unitNumber || "—", date: formatDay(event.whenMs) })
        : t("today.feed.movedOut", { who: event.tenantName || event.unitNumber || "—" });
  }
}

export function FeedItem({ event, nowMs, last }: { event: FeedEvent; nowMs: number; last: boolean }) {
  const { t } = useTranslation();
  const ic = FEED_ICON[event.kind];
  const rentSuffix =
    event.rent !== null && (event.kind === "moveIn" || event.kind === "signed")
      ? ` · $${Math.round(event.rent).toLocaleString()}`
      : "";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingVertical: 8,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: HAIRLINE,
      }}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: ic.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={ic.icon} size={13} color={ic.fg} />
      </View>
      <Text
        className="text-navy dark:text-white"
        numberOfLines={1}
        style={{ flex: 1, fontSize: 12, fontWeight: "600" }}
      >
        {feedTitle(event, t)}
        <Text style={{ color: MUTED, fontWeight: "500" }}>{rentSuffix}</Text>
      </Text>
      <Text style={{ fontSize: 10, fontWeight: "600", color: MUTED }}>
        {feedTimeLabel(event.whenMs, nowMs, t)}
      </Text>
    </View>
  );
}

export function FlowCard({
  events,
  nowMs,
  onGo,
  limit = 6,
}: {
  events: FeedEvent[];
  nowMs: number;
  onGo: () => void;
  limit?: number;
}) {
  const { t } = useTranslation();
  const shown = events.slice(0, limit);
  return (
    <TodayCard
      title={t("today.flow.title")}
      caption={new Date(nowMs).toLocaleDateString(activeLocale(), { weekday: "short", month: "short", day: "numeric" })}
      goLabel={t("today.flow.go")}
      onGo={onGo}
    >
      {shown.length === 0 ? (
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 11.5, paddingVertical: 8 }}>
          {t("today.flow.empty")}
        </Text>
      ) : (
        shown.map((e, i) => <FeedItem key={e.key} event={e} nowMs={nowMs} last={i === shown.length - 1} />)
      )}
    </TodayCard>
  );
}

// ── Move-in / move-out flow chart ───────────────────────────────────────────

const IN_COLOR = "rgba(37,99,180,0.7)";
const OUT_COLOR = "rgba(9,27,84,0.16)";

export function FlowChartCard({ flow }: { flow: MonthlyFlow[] }) {
  const { t } = useTranslation();
  return (
    <TodayCard title={t("today.flowChart.title")} caption={t("today.flowChart.caption")}>
      <BarColumns
        height={72}
        columns={flow.map((m) => ({
          key: String(m.monthMs),
          label: new Date(m.monthMs).toLocaleDateString(activeLocale(), { month: "short" }),
          values: [
            { value: m.moveIns, color: IN_COLOR },
            { value: m.moveOuts, color: OUT_COLOR },
          ],
        }))}
      />
      <BarLegend
        entries={[
          { color: IN_COLOR, label: t("today.flowChart.moveIns") },
          { color: OUT_COLOR, label: t("today.flowChart.moveOuts") },
        ]}
      />
    </TodayCard>
  );
}

// ── Leasing runway ──────────────────────────────────────────────────────────

export interface RunwaySummary {
  expiringCount: number;
  atRisk: number;
  markToMarket: number;
  renewed: number;
  noResponse: number;
  applicants: number;
  approved: number;
  screening: number;
  leaseSent: number;
}

function RunwayLine({ text, pill, last }: { text: string; pill: ReactNode; last: boolean }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 9,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: HAIRLINE,
      }}
    >
      <Text className="text-navy dark:text-white" numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: NAVY }}>
        {text}
      </Text>
      {pill}
    </View>
  );
}

export function RunwayCard({ summary, onGo }: { summary: RunwaySummary; onGo: () => void }) {
  const { t } = useTranslation();
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  return (
    <TodayCard title={t("today.runway.title")} caption={t("today.runway.caption")} goLabel={t("today.runway.go")} onGo={onGo}>
      <RunwayLine
        text={t("today.runway.expiring", { count: summary.expiringCount })}
        pill={<StatusPill label={t("today.runway.noResponsePill", { count: summary.noResponse })} tone="soon" />}
        last={false}
      />
      <RunwayLine
        text={`${t("today.runway.atRisk", { amount: money(summary.atRisk) })} · ${t("today.runway.markToMarket", { amount: signedMoney(summary.markToMarket) })}`}
        pill={<StatusPill label={t("today.runway.renewedPill", { count: summary.renewed })} tone="good" />}
        last={false}
      />
      <RunwayLine
        text={t("today.runway.applicants", {
          count: summary.applicants,
          approved: summary.approved,
          screening: summary.screening,
        })}
        pill={<StatusPill label={t("today.runway.leaseSentPill", { count: summary.leaseSent })} tone="blue" />}
        last
      />
    </TodayCard>
  );
}

// ── Expiring soon (iPad third column) ───────────────────────────────────────

export function ExpiringSoonCard({ rows }: { rows: ExpirationRow[] }) {
  const { t } = useTranslation();
  const shown = rows.slice(0, 5);
  if (shown.length === 0) return null;
  return (
    <TodayCard title={t("today.expiringSoon.title")}>
      {shown.map((row, i) => (
        <View
          key={row.lease.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 8,
            borderBottomWidth: i === shown.length - 1 ? 0 : 1,
            borderBottomColor: HAIRLINE,
          }}
        >
          <Text className="text-navy dark:text-white" numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700" }}>
            {row.lease.unitNumber}
            {row.tenantName ? ` · ${row.tenantName}` : ""}
            <Text style={{ color: MUTED, fontWeight: "500" }}> · {formatDay(row.endMs)}</Text>
          </Text>
          {row.state === "renewed" ? (
            <StatusPill label={t("today.expiringSoon.renewed")} tone="good" />
          ) : row.state === "moveOut" ? (
            <StatusPill label={t("today.expiringSoon.notice")} tone="neutral" />
          ) : row.markToMarket !== null ? (
            <StatusPill label={signedMoney(row.markToMarket)} tone="soon" />
          ) : (
            <StatusPill label={t("leasing.row.noResponse")} tone="soon" />
          )}
        </View>
      ))}
    </TodayCard>
  );
}

// ── Make ready (Work tab's Today line) ──────────────────────────────────────

/**
 * The turn board's morning summary: "N turns in progress · M move-ins this
 * week", then the late/blocked line. Pure presenter — the screen derives the
 * snapshot from the shared work-order engine and passes it down; tapping "go"
 * lands on the Work tab in make-ready mode.
 */
export function MakeReadyCard({
  snapshot,
  onGo,
}: {
  snapshot: MakeReadySnapshot;
  onGo: () => void;
}) {
  const { t } = useTranslation();
  const alerts = [
    snapshot.lateForMoveIn > 0 ? t("today.makeReady.late", { count: snapshot.lateForMoveIn }) : null,
    snapshot.blockedCount > 0 ? t("today.makeReady.blocked", { count: snapshot.blockedCount }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <TodayCard title={t("today.makeReady.title")} goLabel={t("today.makeReady.go")} onGo={onGo}>
      <RunwayLine
        text={t("today.makeReady.progress", {
          count: snapshot.turnsInProgress,
          moveIns: snapshot.moveInsThisWeek,
        })}
        pill={<StatusPill label={t("today.makeReady.readyPill", { count: snapshot.readyUnits })} tone="good" />}
        last={false}
      />
      <RunwayLine
        text={alerts.length > 0 ? alerts.join(" · ") : t("today.makeReady.onTrack")}
        pill={
          alerts.length > 0 ? (
            <StatusPill label={t("today.makeReady.attentionPill")} tone="soon" />
          ) : null
        }
        last
      />
    </TodayCard>
  );
}

// ── Utilities due (Utilities tab's Today line) ──────────────────────────────

/** The Today board's read-only cut of the MLGW mirror. */
export interface UtilitiesDueSummary {
  /** Sum of positive balances due across accounts. */
  due: number;
  billCount: number;
  /** Open (unreviewed) spike + high-electrical exceptions. */
  spikeCount: number;
}

/** "Utilities due $X · N bills", with the spike count as the pill. */
export function UtilitiesCard({
  summary,
  onGo,
}: {
  summary: UtilitiesDueSummary;
  onGo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TodayCard title={t("today.utilities.title")} goLabel={t("today.utilities.go")} onGo={onGo}>
      <RunwayLine
        text={t("today.utilities.due", {
          amount: `$${Math.round(summary.due).toLocaleString()}`,
          count: summary.billCount,
        })}
        pill={
          summary.spikeCount > 0 ? (
            <StatusPill label={t("today.utilities.spikes", { count: summary.spikeCount })} tone="soon" />
          ) : (
            <StatusPill label={t("today.utilities.noSpikes")} tone="good" />
          )
        }
        last
      />
    </TodayCard>
  );
}

// ── Top balances (Money summary) ────────────────────────────────────────────

const BALANCE_DOT: Record<"red" | "amber", string> = { red: "#D1382E", amber: "#E38736" };

export interface BalanceRow {
  unitNumber: string;
  tenant: string;
  balance: number;
  /** Severity by months owed (≥2 months → red), driving the row dot. */
  tone: "red" | "amber";
}

/**
 * The property's largest open balances — the Money tab's headline, surfaced on
 * Today (mockup frame 02's "Top Balances" card). A colored dot flags severity,
 * the tenant rides the meta line, and the amount is right-aligned.
 */
export function TopBalancesCard({
  rows,
  owed,
  count,
  onGo,
}: {
  rows: BalanceRow[];
  owed: number;
  count: number;
  onGo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TodayCard
      title={t("today.balances.title")}
      caption={t("today.balances.caption", { count, amount: `$${Math.round(owed).toLocaleString()}` })}
      goLabel={t("today.balances.go")}
      onGo={onGo}
    >
      {rows.map((r, i) => (
        <View
          key={r.unitNumber}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 9,
            paddingVertical: 8,
            borderBottomWidth: i === rows.length - 1 ? 0 : 1,
            borderBottomColor: HAIRLINE,
          }}
        >
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: BALANCE_DOT[r.tone] }} />
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 12.5, fontWeight: "800", fontVariant: ["tabular-nums"] }}
          >
            {r.unitNumber}
          </Text>
          <Text className="text-muted dark:text-white/50" numberOfLines={1} style={{ flex: 1, fontSize: 11 }}>
            {r.tenant}
          </Text>
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 12.5, fontWeight: "800", fontVariant: ["tabular-nums"] }}
          >
            ${Math.round(r.balance).toLocaleString()}
          </Text>
        </View>
      ))}
    </TodayCard>
  );
}

// ── Cross-feature placeholder ───────────────────────────────────────────────

/**
 * Hidden-until-data card for features this tab does NOT own (make ready from
 * Maintenance, utilities due from Utilities). This screen never imports those
 * stores; the coordinator (or a later wave) passes `data` once the source
 * exists, and until then the card renders nothing at all.
 */
export function LinkedFeatureCard<T>({
  data,
  render,
}: {
  data: T | null | undefined;
  render: (data: T) => ReactNode;
}) {
  if (data === null || data === undefined) return null;
  return <>{render(data)}</>;
}

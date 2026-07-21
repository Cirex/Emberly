import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { StatusPill, type PillTone } from "@/components/leasing/primitives";
import { activeLocale } from "@/lib/i18n";
import type {
  ExpirationRow,
  ForecastRow,
  PipelineRow,
  PipelineStage,
  VacancyRow,
} from "@/lib/derived/leasing";
import { shortPct, signedMoney } from "@/lib/derived/leasing";
import { parseDay } from "@/lib/derived/time";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * Row renderers for the four Leasing modes — the mockup's `.row` anatomy:
 * initials lead, unit + tenant big line, muted sub line, status pill and
 * money on the right. All strings arrive translated via i18n keys; dates
 * format in the active locale.
 */

/** "Jul 21" in the active locale. */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
}

const STAGE_TONE: Record<PipelineStage, PillTone> = {
  application: "neutral",
  screening: "review",
  approved: "good",
  leaseSent: "blue",
  signed: "good",
  movedIn: "good",
};

function RowShell({ children, last }: { children: React.ReactNode; last: boolean }) {
  return (
    <View
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
    </View>
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
    <Text className="text-slate dark:text-white/60" numberOfLines={1} style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
      {text}
    </Text>
  );
}

export function PipelineRowView({ row, last }: { row: PipelineRow; last: boolean }) {
  const { t } = useTranslation();
  const { lease } = row;
  const title = row.tenantName
    ? `${row.tenantName} · ${lease.unitNumber}`
    : lease.unitNumber || "—";
  const appliedMs = parseDay(lease.applicationDate);
  const subParts = [
    row.classification,
    appliedMs !== null ? t("leasing.row.appliedOn", { date: formatDay(appliedMs) }) : "",
    lease.leasingAgent ? t("leasing.row.agent", { agent: lease.leasingAgent }) : "",
  ].filter(Boolean);
  const rightSub =
    row.moveInMs !== null
      ? t(row.stage === "movedIn" ? "leasing.row.movedInOn" : "leasing.row.moveInOn", {
          date: formatDay(row.moveInMs),
        })
      : "";
  return (
    <RowShell last={last}>
      <InitialsBadge name={row.tenantName || lease.unitNumber || "?"} size={30} />
      <View style={{ flex: 1 }}>
        <BigLine text={title} />
        {subParts.length > 0 ? <SubLine text={subParts.join(" · ")} /> : null}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <StatusPill label={t(`leasing.stages.${row.stage}`)} tone={STAGE_TONE[row.stage]} />
        {rightSub ? <SubLine text={rightSub} /> : null}
      </View>
    </RowShell>
  );
}

export function ExpirationRowView({ row, last }: { row: ExpirationRow; last: boolean }) {
  const { t } = useTranslation();
  const { lease } = row;
  const title = row.tenantName ? `${lease.unitNumber} · ${row.tenantName}` : lease.unitNumber;
  const sub = `${t("leasing.row.endsOn", { date: formatDay(row.endMs) })} · ${t("leasing.row.daysLeft", { count: row.daysLeft })}`;

  const statePill =
    row.state === "renewed" ? (
      <StatusPill label={t("leasing.row.renewed")} tone="good" />
    ) : row.state === "moveOut" ? (
      <StatusPill label={t("leasing.row.moveOut")} tone="neutral" />
    ) : (
      <StatusPill label={t("leasing.row.noResponse")} tone="soon" />
    );

  return (
    <RowShell last={last}>
      <View style={{ flex: 1 }}>
        <BigLine text={title} />
        <SubLine text={sub} />
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        {statePill}
        {row.markToMarket !== null && row.state !== "moveOut" ? (
          <Text
            style={{
              fontSize: 10.5,
              fontWeight: "800",
              fontVariant: ["tabular-nums"],
              color: row.markToMarket > 0 ? "#1F7A47" : row.markToMarket < 0 ? "#D1382E" : MUTED,
            }}
          >
            {t("leasing.row.markToMarket", { amount: signedMoney(row.markToMarket) })}
          </Text>
        ) : row.state === "moveOut" ? (
          <SubLine text={t("leasing.row.preLease")} />
        ) : null}
      </View>
    </RowShell>
  );
}

export function VacancyRowView({ row, last }: { row: VacancyRow; last: boolean }) {
  const { t } = useTranslation();
  return (
    <RowShell last={last}>
      <View style={{ flex: 1 }}>
        <BigLine text={row.unitNumber} />
        {row.classification ? <SubLine text={row.classification} /> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <StatusPill
          label={row.ready ? t("leasing.row.ready") : t("leasing.row.notReady")}
          tone={row.ready ? "good" : "soon"}
        />
        {row.marketRent !== null ? (
          <SubLine
            text={t("leasing.row.marketMonthly", {
              amount: `$${Math.round(row.marketRent).toLocaleString()}`,
            })}
          />
        ) : null}
      </View>
    </RowShell>
  );
}

/** The 30/60/90 occupancy-projection table (Forecast mode). */
export function ForecastTable({ rows }: { rows: ForecastRow[] }) {
  const { t } = useTranslation();
  const headerCell = (label: string, flexV = 1, right = true) => (
    <Text
      key={label}
      style={{
        flex: flexV,
        fontSize: 9.5,
        fontWeight: "800",
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: MUTED,
        textAlign: right ? "right" : "left",
      }}
    >
      {label}
    </Text>
  );
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          paddingHorizontal: 14,
          paddingVertical: 9,
          borderBottomWidth: 1,
          borderBottomColor: HAIRLINE,
          gap: 6,
        }}
      >
        {headerCell("", 0.7, false)}
        {headerCell(t("leasing.forecast.occupiedNow"))}
        {headerCell(t("leasing.forecast.moveIns"))}
        {headerCell(t("leasing.forecast.moveOuts"))}
        {headerCell(t("leasing.forecast.projected"))}
      </View>
      {rows.map((row, i) => (
        <View
          key={row.horizonDays}
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 14,
            paddingVertical: 12,
            gap: 6,
            borderBottomWidth: i === rows.length - 1 ? 0 : 1,
            borderBottomColor: HAIRLINE,
          }}
        >
          <Text style={{ flex: 0.7, fontSize: 13, fontWeight: "800", color: NAVY }}>
            {t("leasing.forecast.horizon", { days: row.horizonDays })}
          </Text>
          <Cell text={`${row.occupiedNow.toLocaleString()} / ${row.total.toLocaleString()}`} />
          <Cell text={`+${row.moveIns.toLocaleString()}`} color="#2563B4" />
          <Cell text={`−${row.moveOuts.toLocaleString()}`} color={row.moveOuts > 0 ? "#B05E14" : undefined} />
          <Cell text={shortPct(row.projectedPct)} color="#1F7A47" bold />
        </View>
      ))}
    </View>
  );
}

function Cell({ text, color, bold = false }: { text: string; color?: string; bold?: boolean }) {
  return (
    <Text
      style={{
        flex: 1,
        fontSize: 12,
        fontWeight: bold ? "800" : "600",
        color: color ?? NAVY,
        textAlign: "right",
        fontVariant: ["tabular-nums"],
      }}
    >
      {text}
    </Text>
  );
}

import { useTranslation } from "react-i18next";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { StatusPill, type PillTone } from "@/components/leasing/primitives";
import { activeLocale } from "@/lib/i18n";
import type {
  ExpirationRow,
  ForecastRow,
  PipelineRow,
  PipelineStage,
  TrackerStep,
  VacancyRow,
} from "@/lib/derived/leasing";
import { pipelineTrackerSteps, shortPct, signedMoney } from "@/lib/derived/leasing";
import { calendarDaysBetween, parseDay, startOfDay } from "@/lib/derived/time";
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

function RowShell({
  children,
  last,
  align = "center",
}: {
  children: React.ReactNode;
  last: boolean;
  /** Pipeline rows carry three text lines, so they hang from the top. */
  align?: "center" | "flex-start";
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: align,
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

const TRACK_GOOD = "#33A666";
const TRACK_IDLE = "rgba(9,27,84,0.16)";

/** One dot + label of the five-step funnel tracker (approved artifact). */
function TrackerStepView({ step, first }: { step: TrackerStep; first: boolean }) {
  const { t } = useTranslation();
  const reached = step.state === "done" || step.state === "skip";
  return (
    <View style={{ flex: 1, alignItems: "center" }}>
      {/* Connector into this step; colored once the step is reached or live. */}
      {!first ? (
        <View
          style={{
            position: "absolute",
            top: 6,
            left: "-50%",
            width: "100%",
            height: 2,
            backgroundColor: reached || step.state === "now" ? TRACK_GOOD : TRACK_IDLE,
          }}
        />
      ) : null}
      <View
        style={{
          width: 13,
          height: 13,
          borderRadius: 999,
          borderWidth: step.state === "done" ? 0 : 1.5,
          borderStyle: step.state === "skip" ? "dashed" : "solid",
          borderColor: step.state === "now" || step.state === "skip" ? TRACK_GOOD : TRACK_IDLE,
          backgroundColor: step.state === "done" ? TRACK_GOOD : "#FFFFFF",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {step.state === "done" ? (
          <Text style={{ fontSize: 8, fontWeight: "800", color: "#fff", lineHeight: 10 }}>✓</Text>
        ) : null}
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontSize: 9.5,
          fontWeight: "800",
          letterSpacing: 0.2,
          textTransform: "uppercase",
          marginTop: 4,
          color: reached || step.state === "now" ? NAVY : MUTED,
        }}
      >
        {t(`leasing.tracker.${step.key}`)}
      </Text>
      <Text
        numberOfLines={1}
        style={{ fontSize: 9.5, color: MUTED, fontVariant: ["tabular-nums"], marginTop: 1 }}
      >
        {step.dateMs !== null ? formatDay(step.dateMs) : step.state === "now" ? "—" : " "}
      </Text>
    </View>
  );
}

/** "today" / "tomorrow" / "in 8 days" / "3 days ago" for the move-in line. */
function relativeDay(
  ms: number,
  nowMs: number,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const delta = calendarDaysBetween(startOfDay(nowMs), ms);
  if (delta === 0) return t("leasing.row.today");
  if (delta === 1) return t("leasing.row.tomorrow");
  if (delta > 1) return t("leasing.row.inDays", { count: delta });
  return t("leasing.row.daysAgo", { count: -delta });
}

export function PipelineRowView({
  row,
  last,
  nowMs,
  onPress,
}: {
  row: PipelineRow;
  last: boolean;
  nowMs: number;
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  // The tracker needs real horizontal room; the phone keeps the stage pill.
  const showTracker = width >= 900;
  const { lease } = row;
  const appliedMs = parseDay(lease.applicationDate);

  // The UNIT leads — it is the thing being filled, and it is what a manager
  // scans a leasing board for. The prospect is the second line.
  const whoLine = [row.tenantName, row.classification].filter(Boolean).join(" · ");
  // The agent gets its OWN line rather than sharing a truncating one-liner —
  // it was being clipped away entirely at iPad widths. The applied date joins
  // it only when the tracker is hidden, since the tracker's "Applied" step
  // already carries that date and repeating it is noise.
  const originLine = [
    lease.leasingAgent,
    !showTracker && appliedMs !== null ? t("leasing.row.appliedOn", { date: formatDay(appliedMs) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const content = (
    <>
      <InitialsBadge name={row.tenantName || lease.unitNumber || "?"} size={30} />
      <View style={{ flex: 1, minWidth: 168 }}>
        <BigLine text={lease.unitNumber || "—"} />
        {whoLine ? <SubLine text={whoLine} /> : null}
        {originLine ? <SubLine text={originLine} /> : null}
      </View>
      {showTracker ? (
        <View style={{ flex: 1.45, flexDirection: "row", paddingHorizontal: 10 }}>
          {pipelineTrackerSteps(row).map((step, i) => (
            <TrackerStepView key={step.key} step={step} first={i === 0} />
          ))}
        </View>
      ) : (
        <StatusPill label={t(`leasing.stages.${row.stage}`)} tone={STAGE_TONE[row.stage]} />
      )}
      <View style={{ alignItems: "flex-end", gap: 2, width: 150 }}>
        {/* Readiness is an EXCEPTION flag: a ready unit is the normal case and
            saying so on every row is noise. Only the blockers speak. */}
        {!row.ready ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: "#B05E14" }} />
            <Text numberOfLines={1} style={{ fontSize: 10.5, fontWeight: "800", color: "#B05E14" }}>
              {row.dateAvailableMs !== null
                ? t("leasing.row.notReadyAvail", { date: formatDay(row.dateAvailableMs) })
                : t("leasing.row.notReady")}
            </Text>
          </View>
        ) : null}
        {row.moveInMs !== null ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: 11.5, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}
          >
            {formatDay(row.moveInMs)}
          </Text>
        ) : null}
        {row.moveInMs !== null ? (
          <SubLine text={relativeDay(row.moveInMs, nowMs, t)} />
        ) : null}
      </View>
    </>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button">
        <RowShell last={last} align="flex-start">
          {content}
        </RowShell>
      </Pressable>
    );
  }
  return (
    <RowShell last={last} align="flex-start">
      {content}
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

import { useTranslation } from "react-i18next";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { StatusPill, type PillTone } from "@/components/leasing/primitives";
import { TierGem } from "@/components/leasing/TierGem";
import { activeLocale } from "@/lib/i18n";
import type {
  ExpirationRow,
  ForecastRow,
  PipelineRow,
  PipelineRowFlag,
  PipelineStage,
  TrackerStep,
  VacancyRow,
} from "@/lib/derived/leasing";
import { pipelineRowFlags, pipelineTrackerSteps, shortPct, signedMoney } from "@/lib/derived/leasing";
import { calendarDaysBetween, parseDay, startOfDay } from "@/lib/derived/time";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * Row renderers for the four Leasing modes — the mockup's `.row` anatomy:
 * unit + tenant big line, muted sub line, status pill and money on the right.
 * All strings arrive translated via i18n keys; dates format in the active
 * locale.
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
  rail,
}: {
  children: React.ReactNode;
  last: boolean;
  /** Pipeline rows carry three text lines, so they hang from the top. */
  align?: "center" | "flex-start";
  /** 3px edge stripe in the worst flag's tone; null on a row with nothing wrong. */
  rail?: string | null;
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
      {rail ? (
        <View
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: rail }}
        />
      ) : null}
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
const TRACK_VOID = "#D1382E";

/** One dot + label of the four-step funnel tracker (approved artifact). */
function TrackerStepView({
  step,
  first,
  note,
  voided = false,
}: {
  step: TrackerStep;
  first: boolean;
  /**
   * Stands in for the date when the step has none but something DID happen —
   * "sent Jul 17" under an unsigned Signed step, "voided Jul 18" under a
   * pulled-back one. A blank line there reads as "nothing has occurred".
   */
  note?: string;
  /** The signature was executed and then voided: slashed red ring. */
  voided?: boolean;
}) {
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
          borderWidth: step.state === "done" && !voided ? 0 : 1.5,
          borderStyle: step.state === "skip" ? "dashed" : "solid",
          borderColor: voided
            ? TRACK_VOID
            : step.state === "now" || step.state === "skip"
              ? TRACK_GOOD
              : TRACK_IDLE,
          backgroundColor: step.state === "done" && !voided ? TRACK_GOOD : "#FFFFFF",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {voided ? (
          // The slash through the ring — a signature that was undone, not one
          // that never happened, which is what an empty ring would say.
          <View
            style={{
              position: "absolute",
              width: 15,
              height: 1.5,
              backgroundColor: TRACK_VOID,
              transform: [{ rotate: "-45deg" }],
            }}
          />
        ) : step.state === "done" ? (
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
          color: voided ? TRACK_VOID : reached || step.state === "now" ? NAVY : MUTED,
        }}
      >
        {t(`leasing.tracker.${step.key}`)}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          fontSize: 9.5,
          color: voided ? TRACK_VOID : MUTED,
          fontVariant: ["tabular-nums"],
          marginTop: 1,
        }}
      >
        {note ?? (step.dateMs !== null ? formatDay(step.dateMs) : step.state === "now" ? "—" : " ")}
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

const FLAG_COLOR: Record<PipelineRowFlag["tone"], string> = {
  bad: "#D1382E",
  warn: "#B05E14",
  info: "#2563B4",
};

/**
 * The flag in the manager's language.
 *
 * One line, because `pipelineRowFlags` now returns an i18n key and the values
 * it interpolates. This used to be a switch that re-derived each flag's
 * numbers from the row — the same day counts the engine had just computed —
 * which meant every flag's parameters existed in two files and could drift.
 *
 * The one thing the engine cannot hand over ready-made is a formatted date: it
 * has no locale, so `unitNotReadyAvail` carries `dateMs` and the date is
 * spelled here, in the reader's locale.
 */
function flagLabel(
  flag: PipelineRowFlag,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const params = flag.labelParams;
  if (params !== undefined && typeof params.dateMs === "number") {
    return t(`leasing.flags.${flag.labelKey}`, { ...params, date: formatDay(params.dateMs) });
  }
  return t(`leasing.flags.${flag.labelKey}`, params);
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
  const today = startOfDay(nowMs);
  const appliedMs = parseDay(lease.applicationDate);
  const sentMs = parseDay(lease.leaseSentDate ?? null);
  const voidedMs = parseDay(lease.leaseVoidedDate ?? null);

  const flags = pipelineRowFlags(row, nowMs);
  // pipelineRowFlags is ordered worst-first, so the rail is simply the first
  // flag's tone — and an informational flag (a slipping date) is a fact, not a
  // fault, so it paints no rail at all.
  const railTone = flags.find((flag) => flag.tone !== "info")?.tone ?? null;

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

  // ResMan writes 0 into residentRent for a lease nobody has priced yet (one
  // of the 47 today), so 0 is UNKNOWN here, not a free apartment — the column
  // shows an em-dash and says so out loud to a screen reader.
  const rent = lease.residentRent !== null && lease.residentRent !== undefined && lease.residentRent > 0
    ? lease.residentRent
    : null;

  const content = (
    <>
      <View style={{ width: showTracker ? 238 : undefined, flex: showTracker ? undefined : 1, minWidth: 0 }}>
        {/* The UNIT leads — it is the thing being filled, and it is what a
            manager scans a leasing board for. The tier is a gem rather than a
            word: it costs 13px instead of "Diamond", and the four cuts read
            apart in greyscale. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <TierGem tier={row.tier} />
          <Text
            className="text-navy dark:text-white"
            numberOfLines={1}
            style={{ fontSize: 15.5, fontWeight: "800", letterSpacing: -0.2 }}
          >
            {lease.unitNumber || "—"}
          </Text>
          {row.layout ? (
            <Text numberOfLines={1} style={{ fontSize: 12, color: MUTED }}>
              {`— ${row.layout}`}
            </Text>
          ) : null}
        </View>
        {row.tenantName ? (
          <Text
            className="text-slate dark:text-white/70"
            numberOfLines={1}
            style={{ fontSize: 12.5, color: "#4C556F", marginTop: 2 }}
          >
            {row.tenantName}
          </Text>
        ) : null}
        {/* Who owns the file, deliberately the quietest line on the row. */}
        {originLine ? (
          <Text
            className="text-slate dark:text-white/50"
            numberOfLines={1}
            style={{ fontSize: 11, color: MUTED, marginTop: 1 }}
          >
            {originLine}
          </Text>
        ) : null}
      </View>
      {showTracker ? (
        <View style={{ flex: 1.45, flexDirection: "row", paddingHorizontal: 10 }}>
          {pipelineTrackerSteps(row).map((step, i) => {
            // A lease that went out and came back is not the same as one that
            // never went out. The Signed step carries both stories.
            const voided = step.key === "signed" && voidedMs !== null && step.dateMs === null;
            const note =
              step.key !== "signed" || step.dateMs !== null
                ? undefined
                : voidedMs !== null
                  ? t("leasing.row.voidedOn", { date: formatDay(voidedMs) })
                  : sentMs !== null
                    ? t("leasing.row.sentOn", { date: formatDay(sentMs) })
                    : undefined;
            return (
              <TrackerStepView
                key={step.key}
                step={step}
                first={i === 0}
                note={note}
                voided={voided}
              />
            );
          })}
        </View>
      ) : (
        <StatusPill label={t(`leasing.stages.${row.stage}`)} tone={STAGE_TONE[row.stage]} />
      )}
      {showTracker ? (
        <View style={{ width: 78, alignItems: "flex-end" }}>
          <Text
            numberOfLines={1}
            accessibilityLabel={rent === null ? t("leasing.row.rentNotSet") : undefined}
            style={{ fontSize: 12.5, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}
          >
            {rent !== null ? `$${Math.round(rent).toLocaleString()}` : "—"}
          </Text>
          {/* 44 of the 47 sit exactly at market, so "at market" on every row
              would be noise — only the concession (or the premium) speaks. */}
          {row.rentVariance !== null && row.rentVariance !== 0 ? (
            <Text
              numberOfLines={1}
              style={{
                fontSize: 10.5,
                fontWeight: "800",
                color: "#B05E14",
                fontVariant: ["tabular-nums"],
                marginTop: 1,
              }}
            >
              {`${row.rentVariance < 0 ? "−" : "+"}$${Math.abs(Math.round(row.rentVariance)).toLocaleString()}`}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={{ alignItems: "flex-end", gap: 2, width: showTracker ? 172 : 150 }}>
        {/* Exceptions only: a ready unit, a paid deposit and a moving file are
            the normal case, and saying so on every row is noise. */}
        {flags.map((flag) => (
          <View key={flag.key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View
              style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: FLAG_COLOR[flag.tone] }}
            />
            <Text
              numberOfLines={1}
              style={{ fontSize: 10.5, fontWeight: "800", color: FLAG_COLOR[flag.tone] }}
            >
              {flagLabel(flag, t)}
            </Text>
          </View>
        ))}
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

  const shell = (
    <RowShell last={last} align="flex-start" rail={railTone === null ? null : FLAG_COLOR[railTone]}>
      {content}
    </RowShell>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button">
        {shell}
      </Pressable>
    );
  }
  return shell;
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

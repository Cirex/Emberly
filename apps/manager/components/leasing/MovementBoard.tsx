import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { BarColumns, type BarColumn } from "@/components/leasing/BarColumns";
import { BandHeader } from "@/components/leasing/primitives";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { activeLocale } from "@/lib/i18n";
import type { AgentFunnelRow, CountRow, MovementBoard } from "@/lib/derived/movement";
import { MUTED, NAVY } from "@/theme/tokens";

/** Body text between NAVY ink and MUTED — matches the delinquency board's slate. */
const SLATE = "#4C556F";
const INK = NAVY;

/**
 * OCCUPANCY MOVEMENT — the Leasing board's fourth mode.
 *
 * It replaced a three-row 30/60/90 projection that added scheduled move-ins to
 * today's occupancy without asking whether those move-ins were real. Half of
 * them are not: see the header note on lib/derived/movement.ts.
 *
 * Everything is Views and Texts against the shared primitives; no chart
 * library. The engine hands over finished numbers, so this file only formats.
 */

const ARRIVE = "#33A666";
const DEPART = "#D1382E";
const AMBER = "#B05E14";
const BLUE = "#2563B4";
const HAIR = "rgba(9,27,84,0.10)";
const CHIP = "rgba(9,27,84,0.05)";

const money = (v: number) => `$${Math.round(v).toLocaleString(activeLocale())}`;
const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
const monthLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(activeLocale(), { month: "short", year: "2-digit" });

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontSize: 11, lineHeight: 15, color: MUTED, paddingHorizontal: 15, paddingBottom: 12 }}>
      {children}
    </Text>
  );
}

/** A labelled horizontal proportion row — reasons, stay bands, booked weeks. */
function RatioRow({
  label,
  value,
  max,
  color = DEPART,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
  suffix?: string;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 3 }}>
      <Text numberOfLines={1} style={{ fontSize: 11.5, color: SLATE, width: 140 }}>
        {label}
      </Text>
      <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: CHIP, overflow: "hidden" }}>
        <View style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, height: "100%", backgroundColor: color }} />
      </View>
      <Text
        style={{
          fontSize: 11.5,
          fontWeight: "800",
          color: INK,
          width: 44,
          textAlign: "right",
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
        {suffix ?? ""}
      </Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 4 }}>
      <BandHeader label={title} pad={15} />
      <AppCardSurface kind="panel">{children}</AppCardSurface>
    </View>
  );
}

export function MovementBoardView({ board }: { board: MovementBoard }) {
  const { t } = useTranslation();
  const b = board;
  const tr = (k: string, o?: Record<string, unknown>) => t(`leasing.movement.${k}`, o ?? {});

  // ---- the correction, stated before any number that depends on it ----
  const correction = (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: ARRIVE,
        backgroundColor: CHIP,
        borderRadius: 10,
        padding: 12,
        marginHorizontal: 15,
        marginBottom: 4,
      }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: "800", color: INK, marginBottom: 3 }}>
        {tr("correctionTitle")}
      </Text>
      <Text style={{ fontSize: 11.5, lineHeight: 16, color: SLATE }}>
        {tr("correctionBody", {
          claimedIn: b.claimedArrivals,
          claimedOut: b.claimedDepartures,
          realIn: b.arrivals,
          realOut: b.departures,
        })}
      </Text>
    </View>
  );

  // ---- weekly arrivals against departures ----
  const weekColumns: BarColumn[] = b.weeks.map((w, i) => ({
    key: String(w.startMs),
    // Label every other column so the axis stays readable at 30+ weeks.
    label: i % 2 === 0 ? dayLabel(w.startMs) : "",
    values: [
      { value: w.arrivals, color: w.scheduled ? "rgba(51,166,102,0.42)" : ARRIVE },
      { value: w.departures, color: w.scheduled ? "rgba(209,56,46,0.42)" : DEPART },
    ],
  }));

  const maxMonth = Math.max(1, ...b.months.map((m) => Math.max(m.arrivals, m.departures)));
  const maxExp = Math.max(1, ...b.expirations.map((e) => e.leases));
  const maxReason = Math.max(1, ...b.departureReasons.map((r) => r.n));
  const maxDenial = Math.max(1, ...b.denialReasons.map((r) => r.n));
  const maxCancel = Math.max(1, ...b.cancelReasons.map((r) => r.n));
  const maxStay = Math.max(1, ...b.stayBands.map((s) => s.n));
  const maxBooked = Math.max(1, ...b.scheduledByWeek.map((w) => w.n));
  const reasonLabel = (r: CountRow) => (r.key === "notRecorded" ? tr("notRecorded") : r.key);

  return (
    <View style={{ gap: 4 }}>
      {correction}

      {/* ── week by week ── */}
      <Section title={tr("weeklyTitle")}>
        <View style={{ padding: 15, paddingBottom: 6 }}>
          <BarColumns columns={weekColumns} height={104} />
        </View>
        <View style={{ flexDirection: "row", gap: 14, paddingHorizontal: 15, paddingBottom: 9 }}>
          <Legend color={ARRIVE} label={tr("arrivals")} />
          <Legend color={DEPART} label={tr("departures")} />
          <Legend color="rgba(51,166,102,0.42)" label={tr("scheduled")} />
        </View>
        <Caption>{tr("weeklyCaption", { date: dayLabel(b.toMs) })}</Caption>
      </Section>

      {/* ── month by month ── */}
      <Section title={tr("monthlyTitle")}>
        <View style={{ paddingHorizontal: 15, paddingTop: 11, paddingBottom: 4 }}>
          {b.months.map((m) => (
            <View
              key={m.startMs}
              style={{ flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 11.5, fontWeight: "700", color: INK, width: 58 }}>
                {monthLabel(m.startMs)}
              </Text>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 3 }}>
                <View
                  style={{
                    width: `${(m.arrivals / maxMonth) * 46}%`,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: ARRIVE,
                  }}
                />
                <View
                  style={{
                    width: `${(m.departures / maxMonth) * 46}%`,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: DEPART,
                  }}
                />
              </View>
              <Text style={num(56)}>
                {m.arrivals} / {m.departures}
              </Text>
              <Text
                style={{
                  ...num(38),
                  color: m.net > 0 ? ARRIVE : m.net < 0 ? DEPART : MUTED,
                  fontWeight: "800",
                }}
              >
                {m.net > 0 ? "+" : ""}
                {m.net}
              </Text>
            </View>
          ))}
        </View>
        <Caption>
          {tr("monthlyCaption", { net: b.net > 0 ? `+${b.net}` : String(b.net) })}
        </Caption>
      </Section>

      {/* ── the application funnel ── */}
      <Section title={tr("funnelTitle", { count: b.funnel.total })}>
        <View style={{ padding: 15, paddingBottom: 10 }}>
          <View style={{ flexDirection: "row", gap: 3, height: 46 }}>
            <FunnelSeg n={b.funnel.moved} total={b.funnel.total} color={ARRIVE} label={tr("movedIn")} />
            <FunnelSeg n={b.funnel.denied} total={b.funnel.total} color={DEPART} label={tr("denied")} />
            <FunnelSeg n={b.funnel.cancelled} total={b.funnel.total} color={AMBER} label={tr("cancelled")} />
          </View>
        </View>
        <Caption>
          {tr("funnelCaption", {
            rent: money(b.deniedRent),
            relet: b.deniedUnitsRelet,
            units: b.deniedUnits,
          })}
        </Caption>
      </Section>

      {/* ── why denied / why cancelled ── */}
      <Section title={tr("denialTitle", { count: b.funnel.denied })}>
        <View style={{ padding: 15, paddingBottom: 8 }}>
          {b.denialReasons.map((r) => (
            <RatioRow key={r.key} label={reasonLabel(r)} value={r.n} max={maxDenial} />
          ))}
        </View>
        <Caption>{tr("denialCaption", { days: b.medianDaysToDeny ?? 0 })}</Caption>
      </Section>

      <Section title={tr("cancelTitle", { count: b.funnel.cancelled })}>
        <View style={{ padding: 15, paddingBottom: 8 }}>
          {b.cancelReasons.slice(0, 7).map((r) => (
            <RatioRow key={r.key} label={reasonLabel(r)} value={r.n} max={maxCancel} color={AMBER} />
          ))}
        </View>
        <Caption>
          {tr("cancelCaption", {
            vague: b.vagueCancellations,
            total: b.funnel.cancelled,
            days: b.medianDaysToCancel ?? 0,
            slowest: b.slowestCancelDays ?? 0,
          })}
        </Caption>
      </Section>

      {/* ── funnel by agent ── */}
      {b.agentFunnel.length > 0 ? (
        <Section title={tr("agentTitle")}>
          <View style={{ paddingHorizontal: 15, paddingTop: 11, paddingBottom: 6 }}>
            {b.agentFunnel.map((a) => (
              <AgentRow key={a.agent} row={a} unattributed={tr("unattributed")} />
            ))}
          </View>
          <Caption>{tr("agentCaption")}</Caption>
        </Section>
      ) : null}

      {/* ── the expiration wall ── */}
      <Section title={tr("expiryTitle", { count: b.expiringLeases })}>
        <View style={{ padding: 15, paddingBottom: 8 }}>
          {b.expirations.map((e) => (
            <RatioRow
              key={e.startMs}
              label={monthLabel(e.startMs)}
              value={e.leases}
              max={maxExp}
              color={BLUE}
            />
          ))}
        </View>
        <Caption>{tr("expiryCaption", { rent: money(b.expiringRent) })}</Caption>
      </Section>

      {/* ── booked ahead ── */}
      <Section title={tr("bookedTitle", { count: b.scheduledArrivals.length })}>
        <View style={{ padding: 15, paddingBottom: 8 }}>
          {b.scheduledByWeek.map((w) => (
            <RatioRow
              key={w.startMs}
              label={tr("weekOf", { date: dayLabel(w.startMs) })}
              value={w.n}
              max={maxBooked}
              color={ARRIVE}
            />
          ))}
        </View>
        <Caption>{tr("bookedCaption", { outs: b.scheduledDepartureCount })}</Caption>
      </Section>

      {/* ── why they left, how long they stayed ── */}
      <Section title={tr("departureTitle", { count: b.departures })}>
        <View style={{ padding: 15, paddingBottom: 8 }}>
          {b.departureReasons.slice(0, 8).map((r) => (
            <RatioRow key={r.key} label={reasonLabel(r)} value={r.n} max={maxReason} />
          ))}
        </View>
        <Caption>
          {tr("departureCaption", {
            evictions: b.evictionExits,
            total: b.departures,
            pct: b.departures > 0 ? Math.round((100 * b.evictionExits) / b.departures) : 0,
          })}
        </Caption>
      </Section>

      <Section title={tr("stayTitle")}>
        <View style={{ padding: 15, paddingBottom: 8 }}>
          {b.stayBands.map((s) => (
            <RatioRow key={s.key} label={tr(`stay.${s.key}`)} value={s.n} max={maxStay} color={BLUE} />
          ))}
        </View>
        <Caption>{tr("stayCaption", { days: b.medianStayDays ?? 0, sample: b.staySample })}</Caption>
      </Section>

      {/* ── recent arrivals ── */}
      {b.recentArrivals.length > 0 ? (
        <Section title={tr("recentTitle", { count: b.recentArrivals.length })}>
          <View style={{ paddingTop: 4, paddingBottom: 6 }}>
            {b.recentArrivals.map((a, i) => (
              <View
                key={a.leaseId}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 15,
                  paddingVertical: 7,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: HAIR,
                }}
              >
                <Text style={{ fontSize: 12.5, fontWeight: "800", color: INK, flex: 1 }} numberOfLines={1}>
                  {a.unitNumber}
                </Text>
                <Text style={num(64)}>{dayLabel(a.dateMs)}</Text>
                <Text style={num(62)}>{a.rent === null ? "—" : money(a.rent)}</Text>
                <Text numberOfLines={1} style={{ fontSize: 11, color: MUTED, width: 118, textAlign: "right" }}>
                  {a.agent || tr("unattributed")}
                </Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      <Caption>{tr("horizonNote", { date: dayLabel(b.fromMs) })}</Caption>
    </View>
  );
}

function num(width: number) {
  return {
    fontSize: 11.5,
    color: SLATE,
    width,
    textAlign: "right" as const,
    fontVariant: ["tabular-nums"] as ("tabular-nums")[],
  };
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ fontSize: 10, color: MUTED }}>{label}</Text>
    </View>
  );
}

function FunnelSeg({
  n,
  total,
  color,
  label,
}: {
  n: number;
  total: number;
  color: string;
  label: string;
}) {
  if (n === 0) return null;
  return (
    <View
      style={{
        flex: n,
        minWidth: 66,
        borderRadius: 6,
        backgroundColor: `${color}22`,
        paddingHorizontal: 9,
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: "800", color, fontVariant: ["tabular-nums"] }}>{n}</Text>
      <Text numberOfLines={1} style={{ fontSize: 9.5, color, opacity: 0.85 }}>
        {label} · {total > 0 ? Math.round((100 * n) / total) : 0}%
      </Text>
    </View>
  );
}

/**
 * One agent's applications, split by how they ended. The bar is the story: a
 * book whose outcomes are recorded differently from everyone else's shows up
 * as a differently-coloured bar rather than as a number to be ranked.
 */
function AgentRow({ row, unattributed }: { row: AgentFunnelRow; unattributed: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 4 }}>
      <Text numberOfLines={1} style={{ fontSize: 11.5, fontWeight: "700", color: INK, width: 118 }}>
        {row.agent === "unattributed" ? unattributed : row.agent}
      </Text>
      <Text style={num(28)}>{row.total}</Text>
      <View style={{ flex: 1, flexDirection: "row", height: 9, borderRadius: 5, overflow: "hidden", backgroundColor: CHIP }}>
        <View style={{ flex: Math.max(row.moved, 0.001), backgroundColor: ARRIVE }} />
        <View style={{ flex: Math.max(row.denied, 0.001), backgroundColor: DEPART }} />
        <View style={{ flex: Math.max(row.cancelled, 0.001), backgroundColor: AMBER }} />
      </View>
      <Text style={{ ...num(38), color: row.denialRate >= 0.35 ? DEPART : SLATE }}>
        {Math.round(row.denialRate * 100)}%
      </Text>
      <Text style={{ ...num(38), color: row.cancelRate >= 0.6 ? DEPART : SLATE }}>
        {Math.round(row.cancelRate * 100)}%
      </Text>
    </View>
  );
}

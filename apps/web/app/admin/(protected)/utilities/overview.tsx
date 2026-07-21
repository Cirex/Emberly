import type { CurrentMonthMix, MixGroup, MonthOverMonth, MonthPoint, MoMEntry } from "@/lib/admin-utilities";
import { SpendChart } from "./charts";
import { ChargeBar, NUM, Panel, SEGMENT_FILL, T, money, monthLabel, signedMoney, signedPct } from "./ui";

/** The Portfolio Snapshot panel — artifact overview, left column + MoM. */
export function PortfolioSnapshot({
  series,
  goal,
  mix,
  mom,
}: {
  series: MonthPoint[];
  goal: number | null;
  mix: CurrentMonthMix;
  mom: MonthOverMonth;
}) {
  const latest = series.at(-1);
  return (
    <Panel icon="📈" title="Portfolio Snapshot" subtitle="Monthly trend, current split, and portfolio movement">
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", gap: 24 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <span>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>Monthly Spend</span>
              <span style={{ fontSize: 10.5, color: T.muted, marginLeft: 8 }}>12 months from synced bills</span>
            </span>
            <span style={{ marginLeft: "auto", textAlign: "right" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: T.ink, ...NUM }}>{money(latest?.total ?? 0)}</span>
              <br />
              {latest ? (
                <span style={{ fontSize: 9.5, color: T.accentInk, background: "rgba(180,181,58,0.15)", borderRadius: 999, padding: "2px 8px", fontWeight: 700 }}>
                  {monthLabel(latest.month)}
                </span>
              ) : null}
            </span>
          </div>
          <SpendChart series={series} goal={goal} />

          <div style={{ marginTop: 14 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>Current Month Mix</span>
            <span style={{ fontSize: 10.5, color: T.muted, marginLeft: 8 }}>
              Current bills {mix.month ? `dated ${monthLabel(mix.month)} ` : ""}grouped by charge category
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 6 }}>
            <MixColumn label="Units" dot={T.water} group={mix.units} />
            <MixColumn label="House" dot={T.gas} group={mix.house} />
          </div>
        </div>

        <MonthOverMonthColumn mom={mom} />
      </div>
    </Panel>
  );
}

function MixColumn({ label, dot, group }: { label: string; dot: string; group: MixGroup }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: T.ink, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, background: dot }} />
        {label}
        <span style={{ marginLeft: "auto", color: T.muted, fontWeight: 600, fontSize: 10.5, ...NUM }}>{group.billCount} bills</span>
        <span style={{ fontWeight: 800, marginLeft: 10, ...NUM }}>{money(group.total)}</span>
      </div>
      <ChargeBar segments={group.segments} height={10} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", marginTop: 8, fontSize: 10.5 }}>
        {group.segments.map((s) => (
          <span key={s.key} style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: 3, background: SEGMENT_FILL[s.key], alignSelf: "center" }} />
            <span style={{ color: T.muted, fontWeight: 600 }}>{s.label}</span>
            <span style={{ color: T.muted, fontSize: 9.5, ...NUM }}>{Math.round(s.share * 100)}%</span>
            <span style={{ marginLeft: "auto", fontWeight: 700, color: T.ink, ...NUM }}>{money(s.amount)}</span>
          </span>
        ))}
        {group.segments.length === 0 ? <span style={{ color: T.muted }}>No bills this month.</span> : null}
      </div>
    </div>
  );
}

function DeltaCell({ entry, invert = false }: { entry: MoMEntry; invert?: boolean }) {
  const worse = invert ? entry.delta < 0 : entry.delta > 0;
  const color = entry.delta === 0 ? T.muted : worse ? T.blocked : T.ready;
  return (
    <span style={{ textAlign: "right", fontSize: 10.5, fontWeight: 700, lineHeight: 1.5, color, ...NUM }}>
      {signedMoney(entry.delta)}
      <br />
      {signedPct(entry.pct)}
    </span>
  );
}

function MomRow({
  icon,
  iconColor,
  title,
  value,
  caption,
  right,
  indent = false,
  last = false,
}: {
  icon: string;
  iconColor?: string;
  title: string;
  value: string;
  caption: string;
  right: React.ReactNode;
  indent?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0",
        borderBottom: last ? "none" : `1px solid ${T.line}`,
        marginLeft: indent ? 20 : 0, position: "relative",
      }}
    >
      {indent ? (
        <span
          style={{
            position: "absolute", left: -14, top: -6, width: 11, height: 22,
            borderLeft: `1.5px solid ${T.line}`, borderBottom: `1.5px solid ${T.line}`, borderBottomLeftRadius: 6,
          }}
        />
      ) : null}
      <span style={{ width: 26, height: 26, borderRadius: 8, background: T.wash, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0, color: iconColor }}>
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: T.ink }}>{title}</span>
        <br />
        <span style={{ fontSize: 14, fontWeight: 800, color: T.ink, ...NUM }}>{value}</span>
        <br />
        <span style={{ fontSize: 10, color: T.muted, ...NUM }}>{caption}</span>
      </span>
      {right}
    </div>
  );
}

function MonthOverMonthColumn({ mom }: { mom: MonthOverMonth }) {
  return (
    <div style={{ minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>⇄ Month Over Month</span>
      <div style={{ fontSize: 10.5, color: T.muted, marginBottom: 8 }}>
        {mom.currentMonth ? monthLabel(mom.currentMonth) : "—"} compared with {mom.previousMonth ? monthLabel(mom.previousMonth) : "—"}
      </div>
      <MomRow icon="$" title="Total Spend" value={money(mom.totalSpend.current)}
        caption={`Previous ${money(mom.totalSpend.previous)}`} right={<DeltaCell entry={mom.totalSpend} />} />
      <MomRow indent icon="🏠" title="House Meters" value={money(mom.houseMeters.current)}
        caption={`Previous ${money(mom.houseMeters.previous)}`} right={<DeltaCell entry={mom.houseMeters} />} />
      <MomRow indent icon="🏢" title="Units" value={money(mom.units.current)}
        caption={`Previous ${money(mom.units.previous)}`} right={<DeltaCell entry={mom.units} />} />
      <MomRow icon="⚡" iconColor={T.electricInk} title="Electric" value={money(mom.electric.current)}
        caption={`Previous ${money(mom.electric.previous)}`} right={<DeltaCell entry={mom.electric} />} />
      <MomRow icon="💧" iconColor={T.waterInk} title="Water + Sewer" value={money(mom.waterSewer.current)}
        caption={`Previous ${money(mom.waterSewer.previous)}`} right={<DeltaCell entry={mom.waterSewer} />} />
      <MomRow icon="🚪" title="Vacancy Exposure" value={money(mom.vacancyExposure.total)}
        caption="Total bill from vacant units"
        right={
          <span style={{ textAlign: "right", fontSize: 10.5, fontWeight: 700, lineHeight: 1.5, color: T.gasInk, ...NUM }}>
            {mom.vacancyExposure.shareOfSpend === null ? "—" : `${mom.vacancyExposure.shareOfSpend.toFixed(1)}%`}
            <br />
            {mom.vacancyExposure.billCount} bills
          </span>
        }
      />
      <MomRow last icon="🗓" title="Average Monthly Bill" value={money(mom.averageMonthlyBill.average)}
        caption="12-month average from synced bills"
        right={
          <span style={{ textAlign: "right", fontSize: 10.5, fontWeight: 700, lineHeight: 1.5, color: T.gasInk, ...NUM }}>
            {mom.averageMonthlyBill.billsPerMonth.toFixed(1)} bills/mo
            <br />
            {mom.averageMonthlyBill.monthsSpanned} mo
          </span>
        }
      />
    </div>
  );
}

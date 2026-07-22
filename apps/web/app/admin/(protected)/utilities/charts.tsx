"use client";

import { useState } from "react";
import type { MonthPoint, UtilityBill } from "@/lib/admin-utilities";
import { Callout, NUM, SEGMENT_FILL, T, compactMoney, money, monthLabel } from "./ui";

const SERVICE_ROWS: Array<{ key: keyof MonthPoint["services"]; label: string }> = [
  { key: "balfwd", label: "Bal Fwd" },
  { key: "electric", label: "Electric" },
  { key: "water", label: "Water + Sewer" },
  { key: "gas", label: "Gas" },
  { key: "other", label: "Other MLGW" },
  { key: "nonmlgw", label: "Non-MLGW" },
];

/**
 * The artifact's two SVG charts, dependency-free: the goal-lined monthly
 * spend bars (Portfolio Snapshot) and the smoothed amount-history area with
 * the red move-in rule (bill detail).
 */

export function SpendChart({ series, goal }: { series: MonthPoint[]; goal: number | null }) {
  const W = 560;
  const H = 150;
  const left = 40;
  const right = 552;
  const floorY = 130;
  const topY = 22;
  const max = Math.max(...series.map((p) => p.total), goal ?? 0, 1);
  const scaleY = (v: number) => floorY - (v / max) * (floorY - topY);
  const band = (right - left) / Math.max(series.length, 1);
  const barW = Math.min(30, band * 0.7);
  const gridVals = [max, max / 2];
  const [hover, setHover] = useState<number | null>(null);
  const active = hover !== null ? series[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      {active ? (
        <Callout leftPct={((left + band * hover! + band / 2) / W) * 100}>
          <div style={{ display: "flex", alignItems: "baseline", fontSize: 11.5, fontWeight: 800, color: T.ink }}>
            {monthLabel(active.month)}
            <span style={{ marginLeft: "auto", ...NUM }}>{money(active.total)}</span>
          </div>
          <div style={{ fontSize: 10, color: T.muted, marginTop: 2, ...NUM }}>
            {active.billCount} {active.billCount === 1 ? "bill" : "bills"}
          </div>
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 8, paddingTop: 6 }}>
            {SERVICE_ROWS.filter((row) => active.services[row.key] > 0).map((row) => (
              <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, padding: "2px 0" }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: SEGMENT_FILL[row.key] }} />
                <span style={{ color: T.muted }}>{row.label}</span>
                <span style={{ marginLeft: "auto", fontWeight: 700, color: T.ink, ...NUM }}>{money(active.services[row.key])}</span>
              </div>
            ))}
            {SERVICE_ROWS.every((row) => active.services[row.key] === 0) ? (
              <div style={{ fontSize: 10.5, color: T.muted }}>No charge breakdown this month.</div>
            ) : null}
          </div>
        </Callout>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label="Monthly spend, last 12 months"
        onMouseLeave={() => setHover(null)}
      >
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={left - 6} y1={scaleY(v)} x2={right} y2={scaleY(v)} stroke={T.navy} opacity={0.1} />
          <text x={left - 10} y={scaleY(v) + 3} fontSize={8} fill={T.muted} textAnchor="end">
            {compactMoney(v)}
          </text>
        </g>
      ))}
      <line x1={left - 6} y1={floorY} x2={right} y2={floorY} stroke={T.navy} opacity={0.14} />
      <text x={left - 10} y={floorY + 3} fontSize={8} fill={T.muted} textAnchor="end">$0</text>

      {goal !== null && goal <= max ? (
        <g>
          <line x1={left - 6} y1={scaleY(goal)} x2={right} y2={scaleY(goal)} stroke={T.accent} strokeWidth={2.5} strokeDasharray="8 5" />
          <rect x={right - 86} y={scaleY(goal) - 24} width={80} height={17} rx={8.5} fill="rgba(180,181,58,0.18)" stroke={T.accent} strokeWidth={1} />
          <text x={right - 46} y={scaleY(goal) - 12.5} fontSize={9} fontWeight={700} fill={T.ink} textAnchor="middle">
            Goal {compactMoney(goal)}
          </text>
        </g>
      ) : null}

      {series.map((p, i) => {
        const x = left + band * i + (band - barW) / 2;
        const y = p.total > 0 ? scaleY(p.total) : floorY - 2;
        return (
          <rect
            key={p.month}
            x={x}
            y={y}
            width={barW}
            height={Math.max(floorY - y, 2)}
            rx={4}
            fill={T.water}
            opacity={hover === null || hover === i ? 1 : 0.55}
          />
        );
      })}
      {/* Full-height invisible hover bands: the whole month column is a
          target, so short bars are as hoverable as tall ones. */}
      {series.map((p, i) => (
        <rect
          key={`h-${p.month}`}
          x={left + band * i}
          y={topY - 8}
          width={band}
          height={floorY - topY + 8}
          fill="transparent"
          onMouseEnter={() => setHover(i)}
        />
      ))}
      {series.map((p, i) =>
        i % 2 === 0 ? (
          <text key={`l-${p.month}`} x={left + band * i + band / 2} y={144} fontSize={7.5} fill={T.muted} textAnchor="middle">
            {monthLabel(p.month)}
          </text>
        ) : null,
      )}
      </svg>
    </div>
  );
}

/** Catmull-Rom-ish smoothing via midpoint quadratics — visually matches the
 *  artifact's smoothed path without a curve library. */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x} ${pts[0].y}`;
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x} ${last.y}`;
  return d;
}

export function HistoryChart({
  bills,
  currentId,
  moveInDate,
}: {
  /** Ascending by bill_date, amounts present. */
  bills: UtilityBill[];
  currentId: string;
  moveInDate: string | null;
}) {
  const W = 420;
  const H = 170;
  const left = 12;
  const right = 360;
  const topY = 30;
  const floorY = 158;
  const dated = bills.filter((b) => b.bill_date && b.amount_due !== null);
  if (dated.length === 0) {
    return <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: T.muted }}>No amount history yet.</div>;
  }
  const max = Math.max(...dated.map((b) => b.amount_due ?? 0), 1);
  const min = Math.min(...dated.map((b) => b.amount_due ?? 0), 0);
  const span = Math.max(max - min, 1);
  const x = (i: number) => left + (dated.length === 1 ? 0 : (i / (dated.length - 1)) * (right - left));
  const y = (v: number) => floorY - ((v - min) / span) * (floorY - topY);
  const pts = dated.map((b, i) => ({ x: x(i), y: y(b.amount_due ?? 0) }));
  const line = smoothPath(pts);
  const area = `${line} L${pts[pts.length - 1].x} ${floorY + 4} L${pts[0].x} ${floorY + 4} Z`;

  // Move-in rule lands between the last bill before and first bill after.
  let moveX: number | null = null;
  if (moveInDate) {
    const idx = dated.findIndex((b) => (b.bill_date ?? "") > moveInDate);
    if (idx > 0) moveX = (x(idx - 1) + x(idx)) / 2;
    else if (idx === 0) moveX = left + 4;
  }

  // Month ticks (the XMS chart's dashed verticals): two evenly spaced, deduped.
  const ticks: Array<{ x: number; label: string }> = [];
  if (dated.length >= 4) {
    for (const frac of [1 / 3, 2 / 3]) {
      const i = Math.round((dated.length - 1) * frac);
      const date = dated[i].bill_date;
      if (!date) continue;
      const label = monthLabel(date.slice(0, 7));
      if (!ticks.some((t) => t.label === label)) ticks.push({ x: x(i), label });
    }
  }
  // Dedupe: with a flat history (every bill the same amount) max, mid, and min
  // collapse to one value — duplicate keys and stacked labels otherwise.
  const gridVals = [...new Set([max, (max + min) / 2, min > 0 ? min : (max + min) / 4])];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Bill amount history">
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={left} y1={y(v)} x2={right} y2={y(v)} stroke={T.navy} opacity={0.08} />
          <text x={right + 12} y={y(v) + 3} fontSize={9} fill={T.muted}>{Math.round(v)}</text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={t.label}>
          <line x1={t.x} y1={topY} x2={t.x} y2={floorY} stroke={T.navy} opacity={0.12} strokeDasharray="3 5" />
          <text x={t.x} y={H - 2} fontSize={9} fill={T.muted} textAnchor="middle">
            {t.label}
          </text>
        </g>
      ))}
      <path d={area} fill="rgba(38,52,138,0.10)" />
      <path d={line} fill="none" stroke={T.navy} strokeWidth={2.5} strokeLinecap="round" />
      {moveX !== null ? (
        <g>
          <line x1={moveX} y1={26} x2={moveX} y2={floorY + 4} stroke={T.blocked} strokeWidth={2.4} strokeDasharray="5 4" />
          <rect x={Math.min(Math.max(moveX - 43, 2), right - 86)} y={6} width={86} height={19} rx={9.5} fill={T.blocked} />
          <text x={Math.min(Math.max(moveX, 45), right - 43)} y={19} fontSize={9.5} fontWeight={800} fill="#fff" textAnchor="middle">
            Move-In
          </text>
        </g>
      ) : null}
      {dated.map((b, i) =>
        b.id === currentId ? (
          <circle key={b.id} cx={pts[i].x} cy={pts[i].y} r={5.5} fill={T.accent} stroke={T.navy} strokeWidth={2} />
        ) : (
          <circle key={b.id} cx={pts[i].x} cy={pts[i].y} r={2.6} fill={T.muted} />
        ),
      )}
    </svg>
  );
}

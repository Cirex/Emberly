import type { MonthPoint, UtilityBill } from "@/lib/admin-utilities";
import { T, compactMoney, monthLabel } from "./ui";

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

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Monthly spend, last 12 months">
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
        return <rect key={p.month} x={x} y={y} width={barW} height={Math.max(floorY - y, 2)} rx={4} fill={T.water} />;
      })}
      {series.map((p, i) =>
        i % 2 === 0 ? (
          <text key={`l-${p.month}`} x={left + band * i + band / 2} y={144} fontSize={7.5} fill={T.muted} textAnchor="middle">
            {monthLabel(p.month)}
          </text>
        ) : null,
      )}
    </svg>
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
  const gridVals = [max, (max + min) / 2, min > 0 ? min : (max + min) / 4];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Bill amount history">
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={left} y1={y(v)} x2={right} y2={y(v)} stroke={T.navy} opacity={0.08} />
          <text x={right + 12} y={y(v) + 3} fontSize={9} fill={T.muted}>{Math.round(v)}</text>
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

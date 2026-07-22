/**
 * Pure HTML template for the monthly owner report — (figures) → a fully
 * self-contained document matching the approved mockup's Letter page:
 *
 *   header (property + reporting period) → 4 KPI boxes with tinted deltas →
 *   two-column tables (leasing/turns left, aging/maintenance right) →
 *   trailing-12-month occupancy polyline → footer
 *   "Generated <date> · Emberly sync worker · figures from ResMan + MLGW as
 *   synced · Page 1 of 2".
 *
 * Inline CSS only, zero external assets (the Chromium renderer aborts every
 * outbound request at the route level, so a stray reference would blank the
 * render — see mlgw/capture/pdf-renderer.ts). Letter-friendly: @page size +
 * print-safe colors; the renderer adds its own 0.4in margins.
 *
 * NULL BLOCKS ARE OMITTED, never faked: a null delta renders no delta line, a
 * null renewals block renders no renewals row, a null vacancy cost renders no
 * vacancy row — the same honesty rule as the app's trends charts.
 */

import type { ReportFigures } from "./figures";

const GOOD = "#33A666";
const BAD = "#D1382E";
const WARN = "#B05E14";
const INK = "#14202e";
const NAVY = "#091B54";
const MUTED = "#5b6b7c";
const FAINT = "#7b8b9c";
const RULE = "#dfe6ec";
const RULE_SOFT = "#eef2f6";

// ── Formatting ──────────────────────────────────────────────────────────────

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "$1,442" — exact money, no decimals. */
function money(value: number): string {
  const rounded = Math.round(Math.abs(value));
  return `${value < 0 ? "−$" : "$"}${rounded.toLocaleString("en-US")}`;
}

/** "$48.2k" / "$1.24M" / "$412" — the mockup's compact money. */
function moneyCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−$" : "$";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs).toLocaleString("en-US")}`;
}

function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** "Aug 1, 2026" from an ISO timestamp. */
function displayDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(0, 10);
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── Fragments ───────────────────────────────────────────────────────────────

function kpi(label: string, value: string, valueColor: string | null, delta: string | null, deltaColor: string): string {
  const v = `<div class="v"${valueColor ? ` style="color:${valueColor}"` : ""}>${value}</div>`;
  const d = delta ? `<div class="d" style="color:${deltaColor}">${delta}</div>` : "";
  return `<div class="kpi"><div class="l">${label}</div>${v}${d}</div>`;
}

/** Simple label/value table; rows are pre-escaped fragments. */
function kvTable(rows: Array<[string, string]>): string {
  const body = rows
    .map(([label, value]) => `<tr><td>${label}</td><td class="r b">${value}</td></tr>`)
    .join("");
  return `<table class="ptbl">${body}</table>`;
}

function occupancyPolyline(series: ReportFigures["occupancySeries"]): string {
  const points = series
    .map((entry) => entry.occupancyPct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (points.length < 2) {
    return `<div class="nochart">Occupancy history appears here once monthly snapshots accrue — the series began too recently to chart.</div>`;
  }
  const width = 540;
  const height = 54;
  const lo = Math.min(...points) - 0.5;
  const hi = Math.max(...points) + 0.5;
  const span = hi - lo || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points
    .map((v, i) => {
      const x = Math.round(i * step * 10) / 10;
      const y = Math.round((6 + (1 - (v - lo) / span) * (height - 12)) * 10) / 10;
      return `${x},${y}`;
    })
    .join(" ");
  const grid = [14, 28, 42]
    .map((y) => `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${RULE_SOFT}"/>`)
    .join("");
  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${grid}<polyline points="${coords}" fill="none" stroke="${GOOD}" stroke-width="2"/></svg>`;
}

// ── The page ────────────────────────────────────────────────────────────────

export function renderOwnerReportHtml(figures: ReportFigures): string {
  const f = figures;

  // KPI 1 — occupancy.
  const occValue = f.occupancy.pct !== null ? pct(f.occupancy.pct) : "—";
  const occDelta =
    f.occupancy.momDeltaPts !== null
      ? `${f.occupancy.momDeltaPts >= 0 ? "▲" : "▼"} ${Math.abs(f.occupancy.momDeltaPts).toFixed(1)} pt MoM`
      : null;
  const occDeltaColor = (f.occupancy.momDeltaPts ?? 0) >= 0 ? GOOD : BAD;

  // KPI 2 — collections.
  const colValue = f.collections.ratePct !== null ? pct(f.collections.ratePct) : "—";
  const colDelta =
    f.collections.collected !== null && f.collections.billed !== null
      ? `${moneyCompact(f.collections.collected)} of ${moneyCompact(f.collections.billed)}`
      : null;

  // KPI 3 — delinquency (down is good).
  const delValue = f.delinquency.total !== null ? moneyCompact(f.delinquency.total) : "—";
  const delDelta =
    f.delinquency.momDelta !== null
      ? `${f.delinquency.momDelta <= 0 ? "▼" : "▲"} ${moneyCompact(Math.abs(f.delinquency.momDelta))} MoM`
      : null;
  const delDeltaColor = (f.delinquency.momDelta ?? 0) <= 0 ? GOOD : BAD;

  // KPI 4 — utility spend (up is warn).
  const utilValue = f.utilities.spend !== null ? moneyCompact(f.utilities.spend) : "—";
  const utilDelta =
    f.utilities.momDeltaPct !== null
      ? `${f.utilities.momDeltaPct >= 0 ? "▲" : "▼"} ${Math.abs(f.utilities.momDeltaPct).toFixed(1)}% MoM`
      : null;
  const utilDeltaColor = (f.utilities.momDeltaPct ?? 0) >= 0 ? WARN : GOOD;

  // Leasing table.
  const leasingRows: Array<[string, string]> = [
    ["Move-ins", String(f.leasing.moveIns)],
    ["Move-outs", String(f.leasing.moveOuts)],
    ["Applications received", String(f.leasing.applications)],
  ];
  if (f.leasing.renewals !== null) {
    leasingRows.push([
      "Renewals accepted / offers out",
      `${f.leasing.renewals.accepted} / ${f.leasing.renewals.offersOut}`,
    ]);
  }
  if (f.leasing.avgSignedRent !== null) {
    leasingRows.push(["Avg lease rent signed", money(f.leasing.avgSignedRent)]);
  }
  if (f.leasing.lossToLeasePerYear !== null) {
    leasingRows.push(["Loss to lease", `${moneyCompact(f.leasing.lossToLeasePerYear)} / yr`]);
  }

  // Turns table.
  const turnsRows: Array<[string, string]> = [
    ["Completed", String(f.turns.completed)],
    ["In progress · late for move-in", `${f.turns.inProgress} · ${f.turns.lateForMoveIn}`],
  ];
  if (f.turns.avgDaysInTurn !== null) {
    turnsRows.push(["Avg days in turn", f.turns.avgDaysInTurn.toFixed(1)]);
  }
  if (f.turns.vacancyCost !== null) {
    turnsRows.push(["Vacancy cost (days × market)", moneyCompact(f.turns.vacancyCost)]);
  }

  // Aging table (with units + balance columns, plus the actions row).
  let agingTable = "";
  if (f.delinquency.aging !== null) {
    const rows = f.delinquency.aging
      .map(
        (b) =>
          `<tr><td>${b.bucket === "0-30" ? "0–30 days" : b.bucket.replace("-", "–")}</td>` +
          `<td class="r">${b.units}</td><td class="r">${moneyCompact(b.balance)}</td></tr>`,
      )
      .join("");
    const actions = f.delinquency.actions
      ? `<tr><td class="b">Actions this month</td><td class="r b" colspan="2">` +
        `${f.delinquency.actions.notices} notices · ${f.delinquency.actions.promises} promises · ` +
        `${f.delinquency.actions.fedFilings} FED</td></tr>`
      : "";
    agingTable =
      `<h4>Delinquency aging</h4><table class="ptbl">` +
      `<tr><th></th><th class="r">Units</th><th class="r">Balance</th></tr>${rows}${actions}</table>`;
  }

  // Maintenance table.
  const maintenanceRows: Array<[string, string]> = [
    ["Work orders closed", String(f.maintenance.closed)],
    ["Emergencies", String(f.maintenance.emergencies)],
  ];
  if (f.maintenance.callbackRatePct !== null) {
    maintenanceRows.push(["Callback rate", pct(f.maintenance.callbackRatePct)]);
  }
  if (f.maintenance.preventive !== null) {
    maintenanceRows.push([
      "Preventive tasks completed",
      `${f.maintenance.preventive.completed} / ${f.maintenance.preventive.total} · ${f.maintenance.preventive.onTime} on time`,
    ]);
  }

  const unitsLine =
    f.property.totalUnits !== null
      ? `${f.property.totalUnits} units · Memphis, TN · prepared by Emberly Manager`
      : "Memphis, TN · prepared by Emberly Manager";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(f.property.name)} — Monthly Report — ${esc(f.periodLabel)}</title>
<style>
  @page { size: Letter; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: ${INK};
    font-size: 12px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .phead { display: flex; align-items: baseline; border-bottom: 3px solid ${NAVY}; padding-bottom: 12px; }
  .phead h1 { font-size: 22px; margin: 0; color: ${NAVY}; letter-spacing: -0.3px; }
  .phead .sub { font-size: 11px; color: ${MUTED}; margin-top: 3px; }
  .phead .mon { margin-left: auto; text-align: right; font-size: 11px; color: ${MUTED}; }
  .phead .mon b { display: block; font-size: 16px; color: ${INK}; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0; }
  .kpi { border: 1px solid ${RULE}; border-radius: 6px; padding: 10px 12px; }
  .kpi .l { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: ${FAINT}; }
  .kpi .v { font-size: 20px; font-weight: 800; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .kpi .d { font-size: 10px; font-weight: 700; margin-top: 2px; }
  h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; color: ${NAVY}; border-bottom: 1px solid ${RULE}; padding-bottom: 4px; margin: 16px 0 8px; }
  .ptbl { width: 100%; border-collapse: collapse; font-size: 11px; }
  .ptbl th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: ${FAINT}; padding: 4px 5px; border-bottom: 1px solid ${RULE}; }
  .ptbl td { padding: 5px; border-bottom: 1px solid ${RULE_SOFT}; color: #3d4c5c; font-variant-numeric: tabular-nums; }
  .ptbl td.r, .ptbl th.r { text-align: right; }
  .ptbl td.b { font-weight: 800; color: ${INK}; }
  .twocol { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
  .nochart { font-size: 10px; color: ${FAINT}; border: 1px dashed ${RULE}; border-radius: 6px; padding: 12px; }
  .pfoot { margin-top: 14px; font-size: 9px; color: ${FAINT}; border-top: 1px solid ${RULE}; padding-top: 8px; display: flex; }
  .pfoot span:last-child { margin-left: auto; }
</style>
</head>
<body>
  <div class="phead">
    <div>
      <h1>${esc(f.property.name)} — Monthly Report</h1>
      <div class="sub">${esc(unitsLine)}</div>
    </div>
    <div class="mon">Reporting period<b>${esc(f.periodLabel)}</b></div>
  </div>

  <div class="kpis">
    ${kpi("Occupancy", occValue, f.occupancy.pct !== null ? GOOD : null, occDelta, occDeltaColor)}
    ${kpi("Collections", colValue, null, colDelta, GOOD)}
    ${kpi("Delinquent", delValue, f.delinquency.total !== null ? BAD : null, delDelta, delDeltaColor)}
    ${kpi("Utility spend", utilValue, null, utilDelta, utilDeltaColor)}
  </div>

  <div class="twocol">
    <div>
      <h4>Leasing activity</h4>
      ${kvTable(leasingRows)}
      <h4>Turns</h4>
      ${kvTable(turnsRows)}
    </div>
    <div>
      ${agingTable}
      <h4>Maintenance</h4>
      ${kvTable(maintenanceRows)}
    </div>
  </div>

  <h4>Occupancy — trailing 12 months</h4>
  ${occupancyPolyline(f.occupancySeries)}

  <div class="pfoot">
    <span>Generated ${esc(displayDate(f.generatedAt))} · Emberly sync worker · figures from ResMan + MLGW as synced</span>
    <span>Page 1 of 2</span>
  </div>
</body>
</html>
`;
}

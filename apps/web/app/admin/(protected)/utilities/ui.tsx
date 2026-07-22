"use client";

import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/**
 * Visual vocabulary for /admin/utilities, transcribed from the approved
 * artifact (light pass): the Emberly service ramp with darkened -ink variants
 * for text on white, XMS's radii hierarchy, and the small shared surfaces
 * (panel, summary strip, pills, micro-labels).
 */

export const T = {
  ink: "#1B255F",
  muted: "#6A6F8A",
  line: "#DDE1F0",
  navy: "#26348A",
  wash: "rgba(27,37,95,0.045)",
  track: "rgba(27,37,95,0.10)",
  electric: "#B4B53A",
  electricInk: "#8F9027",
  water: "#458ADB",
  waterInk: "#2F6FB8",
  gas: "#E38736",
  gasInk: "#C06A1C",
  balfwd: "#DA6055",
  balfwdInk: "#C24A40",
  other: "#7A6BC7",
  nonmlgw: "#3A48A0",
  blocked: "#D1382E",
  ready: "#33A666",
  review: "#7A6BC7",
  accent: "#B4B53A",
  accentInk: "#75761F",
} as const;

export const SEGMENT_FILL: Record<string, string> = {
  balfwd: T.balfwd,
  electric: T.electric,
  water: T.water,
  gas: T.gas,
  other: T.other,
  nonmlgw: T.nonmlgw,
};
export const SEGMENT_INK: Record<string, string> = {
  balfwd: T.balfwdInk,
  electric: T.electricInk,
  water: T.waterInk,
  gas: T.gasInk,
  other: T.other,
  nonmlgw: T.nonmlgw,
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function money(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : usd.format(v);
}
export function money0(v: number): string {
  return usd0.format(v);
}
/** $12K / $1.2M — the chart-axis + pill format from XMS. */
export function compactMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return usd0.format(v);
}
export function signedMoney(v: number): string {
  return `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
}
export function signedPct(v: number | null): string {
  return v === null ? "No prior" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function monthLabel(month: string): string {
  const d = new Date(`${month}-01T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export const NUM: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

export function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted }}>
      {children}
    </div>
  );
}

/** The artifact's white panel with the icon-chip header. */
export function Panel({
  icon,
  title,
  subtitle,
  right,
  children,
  padding = 16,
}: {
  icon?: IconName;
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  padding?: number;
}) {
  return (
    <div style={{ border: `1px solid ${T.line}`, borderRadius: 14, padding, marginTop: 14, background: "#fff" }}>
      {title ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
          {icon ? (
            <span
              style={{
                width: 28, height: 28, borderRadius: 8, background: T.wash, color: T.navy,
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}
            >
              <Icon name={icon} size={15} />
            </span>
          ) : null}
          <span>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{title}</span>
            {subtitle ? <span style={{ display: "block", fontSize: 11, color: T.muted, marginTop: 1 }}>{subtitle}</span> : null}
          </span>
          <span style={{ flex: 1 }} />
          {right}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** The artifact's tinted summary strip (BILLS · LEDGER TOTAL · …). */
export function Strip({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: `repeat(${items.length}, minmax(120px, 1fr))`,
        borderRadius: 10, background: T.wash, marginBottom: 12, overflow: "hidden",
      }}
    >
      {items.map((item, i) => (
        <div key={item.label} style={{ padding: "10px 14px", borderLeft: i > 0 ? `1px solid ${T.line}` : "none" }}>
          <MicroLabel>{item.label}</MicroLabel>
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 3, color: T.ink, ...NUM }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Pill({ tone, children }: { tone: "current" | "archived" | "processed" | "risk"; children: ReactNode }) {
  const styles: Record<string, { bg: string; fg: string }> = {
    current: { bg: "rgba(180,181,58,0.18)", fg: T.accentInk },
    archived: { bg: T.wash, fg: T.muted },
    processed: { bg: "rgba(51,166,102,0.14)", fg: T.ready },
    risk: { bg: "rgba(209,56,46,0.10)", fg: T.blocked },
  };
  const s = styles[tone];
  return (
    <span style={{ display: "inline-block", fontSize: 9.5, fontWeight: 800, borderRadius: 999, padding: "3px 10px", background: s.bg, color: s.fg }}>
      {children}
    </span>
  );
}

/** The XMS hover callout: white card, hairline, shadow, downward arrow. */
export function Callout({
  children,
  leftPct,
}: {
  children: ReactNode;
  /** Horizontal anchor within the relative parent, 0–100. */
  leftPct: number;
}) {
  // px-aware clamp: keep the 240px card inside the positioned parent even when
  // the anchor sits near an edge (a % clamp alone still overflows narrow bars).
  const left = `clamp(124px, ${leftPct}%, calc(100% - 124px))`;
  return (
    <div
      style={{
        position: "absolute", bottom: "calc(100% + 8px)", left, transform: "translateX(-50%)",
        zIndex: 30, width: 240, background: "#fff", border: `1px solid ${T.line}`, borderRadius: 12,
        boxShadow: "0 14px 34px rgba(27,37,95,0.22)", padding: 12, pointerEvents: "none",
      }}
      role="status"
    >
      {children}
      <span
        style={{
          position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)",
          width: 0, height: 0, borderLeft: "7px solid transparent", borderRight: "7px solid transparent",
          borderTop: "7px solid #fff",
        }}
      />
    </div>
  );
}

export interface BarSegment {
  key: string;
  label: string;
  amount: number;
  share: number;
  /** Itemized fee lines shown under the segment (the "Other" popover). */
  feeItems?: Array<{ label: string; amount: number }>;
}

/** The stacked capsule charge bar (heights 10 in mix, 7 in ledger rows),
 *  with XMS's per-segment hover popover. */
export function ChargeBar({
  segments,
  height,
}: {
  segments: BarSegment[];
  height: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Segment centers for anchoring the callout.
  let acc = 0;
  const centers = segments.map((s) => {
    const w = Math.max(s.share * 100, 1);
    const center = acc + w / 2;
    acc += w;
    return center;
  });
  const active = hover !== null ? segments[hover] : null;
  return (
    <span style={{ position: "relative", display: "block" }}>
      {active ? (
        <Callout leftPct={centers[hover!]}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 800, color: T.ink }}>
            <span style={{ width: 7, height: 7, borderRadius: 3, background: SEGMENT_FILL[active.key] }} />
            {active.label}
            <span style={{ marginLeft: "auto", ...NUM }}>{money(active.amount)}</span>
          </div>
          <div style={{ fontSize: 10, color: T.muted, marginTop: 2, ...NUM }}>{Math.round(active.share * 100)}% of this bill</div>
          {active.feeItems && active.feeItems.length > 0 ? (
            <div style={{ borderTop: `1px dashed ${T.line}`, marginTop: 8, paddingTop: 6 }}>
              {active.feeItems.map((f) => (
                <div key={f.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, padding: "2px 0" }}>
                  <span style={{ color: T.muted }}>{f.label}</span>
                  <span style={{ fontWeight: 700, color: T.ink, ...NUM }}>{money(f.amount)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Callout>
      ) : null}
      <span
        style={{ display: "flex", height, borderRadius: height * 0.6, overflow: "hidden", background: T.track }}
        onMouseLeave={() => setHover(null)}
      >
        {segments.map((s, i) => (
          <span
            key={s.key}
            onMouseEnter={() => setHover(i)}
            style={{ width: `${Math.max(s.share * 100, 1)}%`, background: SEGMENT_FILL[s.key] }}
          />
        ))}
      </span>
    </span>
  );
}

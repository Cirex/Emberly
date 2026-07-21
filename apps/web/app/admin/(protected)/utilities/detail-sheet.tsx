"use client";

import { useEffect } from "react";
import type {
  AccountSummary,
  BillDetailStats,
  LedgerTreeNode,
  UtilityBill,
  UtilityPayment,
  UtilityUnitFacts,
} from "@/lib/admin-utilities";
import { chargeSegmentsOf, newChargesOf } from "@/lib/admin-utilities";
import { HistoryChart } from "./charts";
import { MicroLabel, NUM, Panel, Pill, SEGMENT_FILL, SEGMENT_INK, Strip, T, money, shortDate } from "./ui";

/**
 * The bill detail sheet (artifact): gradient banner with fact chips and the
 * big DUE NOW, metric tiles, Occupancy Context, Amount History + Current
 * Charge Mix, Expense Ledger, Ledger Tree, and Account Payments — as a
 * slide-over dialog on the dimmed page.
 */

export interface AccountDetail {
  bills: UtilityBill[];
  payments: UtilityPayment[];
  tree: LedgerTreeNode[];
  stats: BillDetailStats | null;
  unit: UtilityUnitFacts | null;
}

export function DetailSheet({
  summary,
  detail,
  onClose,
}: {
  summary: AccountSummary;
  detail: AccountDetail;
  onClose: () => void;
}) {
  const { account } = summary;
  const current = detail.bills.find((b) => b.is_current) ?? detail.bills[0] ?? null;
  const stats = detail.stats;
  const afterMoveIn = stats?.afterMoveIn ?? null;
  const tint = account.is_house_account ? T.gas : T.water;
  const tintInk = account.is_house_account ? T.gasInk : T.waterInk;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const historyAsc = detail.bills
    .slice()
    .sort((a, b) => (a.bill_date ?? "").localeCompare(b.bill_date ?? ""));
  const ledgerTotal = detail.bills.reduce((acc, b) => acc + (b.amount_due ?? 0), 0);
  const paidTotal = detail.payments.reduce((acc, p) => acc + (p.amount ?? 0), 0);
  const currentSegments = current ? chargeSegmentsOf(current) : [];
  const maxSegment = Math.max(...currentSegments.map((s) => s.amount), 1);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Utility account ${account.account_number}`}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(27,37,95,0.35)", overflowY: "auto", padding: "26px 16px" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 880, margin: "0 auto", background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 30px 70px rgba(27,37,95,0.35)" }}
      >
        {/* Banner */}
        <div
          style={{
            display: "flex", alignItems: "center", gap: 14, padding: 18,
            background: `linear-gradient(120deg, ${tint}29, #fff 65%)`, borderBottom: `1px solid ${tint}73`,
          }}
        >
          <span style={{ width: 54, height: 54, borderRadius: 13, background: `${tint}29`, color: tintInk, border: `1px solid ${tint}66`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 23, flexShrink: 0 }}>
            {account.is_house_account ? "🏠" : "🏢"}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 17, fontWeight: 800, color: T.ink }}>{account.service_address || account.account_number}</span>
            {detail.unit?.move_in_date && afterMoveIn ? (
              <span style={{ marginLeft: 10, fontSize: 10, fontWeight: 800, color: "#fff", background: T.blocked, borderRadius: 999, padding: "3px 10px", verticalAlign: 2 }}>
                👤 Move-In {shortDate(detail.unit.move_in_date)}
              </span>
            ) : null}
            <span style={{ display: "flex", gap: 7, marginTop: 9, flexWrap: "wrap" }}>
              <Fact label="ACCOUNT" value={account.account_number} />
              {current?.bill_for ? <Fact label="SERVICE FOR" value={current.bill_for} /> : null}
              {current ? <Fact label="DOCUMENT" value={`#${current.document_id}`} /> : null}
            </span>
          </span>
          <span style={{ textAlign: "right" }}>
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: T.muted }}>DUE NOW</span>
            <br />
            <span style={{ fontSize: 27, fontWeight: 800, letterSpacing: "-0.02em", color: T.ink, ...NUM }}>{money(summary.dueNow)}</span>
            <br />
            {current?.file_path ? (
              <a
                href={`/api/admin/utilities/invoice/${encodeURIComponent(current.id)}`}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", marginTop: 5, fontSize: 10.5, fontWeight: 800, color: "#fff", background: T.navy, borderRadius: 999, padding: "6px 13px", textDecoration: "none" }}
              >
                🧾 Open Invoice
              </a>
            ) : (
              <span style={{ display: "inline-block", marginTop: 5, fontSize: 10.5, fontWeight: 800, color: T.muted, background: T.wash, borderRadius: 999, padding: "6px 13px" }}>
                🧾 No invoice file
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ width: 28, height: 28, borderRadius: 14, background: T.wash, color: T.muted, border: "none", cursor: "pointer" }}
          >
            ✕
          </button>
        </div>

        {/* Metric tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 10, padding: "16px 18px 0" }}>
          <Tile icon="📄" tintBg="rgba(180,181,58,0.16)" tintFg={T.accentInk} label="Due Now"
            value={money(summary.dueNow)} caption={current ? `Bill date ${shortDate(current.bill_date)}` : "No current bill"} />
          <Tile icon="＝" tintBg="rgba(69,138,219,0.13)" tintFg={T.waterInk} label="Average"
            value={money(stats?.average ?? null)} caption={`${stats?.amountRecords ?? 0} amount records`} />
          <Tile icon="↗" tintBg="rgba(227,135,54,0.14)" tintFg={T.gasInk} label="Highest"
            value={money(stats?.highest?.amount ?? null)} caption={stats?.highest ? shortDate(stats.highest.billDate) : "—"} />
          <Tile icon="🕐" tintBg="rgba(122,107,199,0.14)" tintFg={T.review} label="Previous"
            value={stats?.previousDelta ? `${stats.previousDelta.delta >= 0 ? "+" : "−"}${money(Math.abs(stats.previousDelta.delta))}` : "No prior"}
            caption={stats?.previousDelta ? `Compared to ${shortDate(stats.previousDelta.previousDate)}` : "First bill on record"} />
          {afterMoveIn ? (
            <Tile icon="👤" tintBg="rgba(209,56,46,0.10)" tintFg={T.blocked} label="After Move-In"
              value={<span style={{ color: T.blocked }}>{money(afterMoveIn.total)}</span>}
              caption={`${afterMoveIn.billCount} bills since ${shortDate(afterMoveIn.since)}`} />
          ) : null}
        </div>

        {/* Occupancy Context */}
        {detail.unit ? (
          <div style={{ padding: "14px 18px 0" }}>
            <Panel icon="🪪" title="Occupancy Context" subtitle="ResMan unit dates overlaid against the utility ledger" padding={16}>
              {afterMoveIn ? (
                <div style={{ display: "flex", gap: 11, alignItems: "center", background: "rgba(209,56,46,0.07)", border: "1px solid rgba(209,56,46,0.25)", borderRadius: 10, padding: "11px 14px", marginBottom: 12 }}>
                  <span style={{ fontSize: 16, color: T.blocked }}>👤</span>
                  <span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: T.ink }}>Owner-paid utility activity after tenant move-in</span>
                    <br />
                    <span style={{ fontSize: 11, color: T.muted, ...NUM }}>
                      {afterMoveIn.billCount} bills totaling {money(afterMoveIn.total)} after {shortDate(afterMoveIn.since)}
                    </span>
                  </span>
                </div>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: "12px 20px", fontSize: 12 }}>
                <Field k="Matched Unit" v={`Unit ${detail.unit.unit_number}`} />
                <Field k="Occupancy Status" v={detail.unit.occupancy_status ?? "—"} />
                <Field k="Tenant" v={detail.unit.tenant_names.join(", ") || "—"} />
                <Field k="Move-In" v={shortDate(detail.unit.move_in_date)} />
                <Field k="Move-Out" v={detail.unit.move_out_date ? shortDate(detail.unit.move_out_date) : "None"} />
                <Field k="Lease Start" v={shortDate(detail.unit.lease_start_date)} />
                <Field k="Lease End" v={shortDate(detail.unit.lease_end_date)} />
              </div>
            </Panel>
          </div>
        ) : null}

        {/* Charts */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "0 18px", marginTop: 14 }}>
          <Panel icon="📈" title="Amount History" subtitle={`${stats?.amountRecords ?? 0} bills with amount data`} padding={14}>
            {current ? (
              <HistoryChart bills={historyAsc} currentId={current.id} moveInDate={detail.unit?.move_in_date ?? null} />
            ) : null}
          </Panel>
          <Panel icon="📊" title="Current Charge Mix" subtitle="Service totals from the selected bill" padding={14}>
            {currentSegments.map((s) => (
              <div key={s.key}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: T.muted, margin: "10px 0 4px" }}>{s.label}</div>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ width: `${Math.max((s.amount / maxSegment) * 82, 4)}%`, height: 26, borderRadius: 6, background: SEGMENT_FILL[s.key], display: "inline-block" }} />
                  <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 8, whiteSpace: "nowrap", color: T.ink, ...NUM }}>{money(s.amount)}</span>
                </div>
              </div>
            ))}
            {currentSegments.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: T.muted }}>No charge breakdown on this bill.</div>
            ) : null}
          </Panel>
        </div>

        <div style={{ padding: "0 18px 14px" }}>
          {/* Expense Ledger */}
          <Panel icon="☰" title="Expense Ledger" subtitle="Current bill plus archived expenses for this account">
            <Strip
              items={[
                { label: "Bills", value: detail.bills.length },
                { label: "Ledger Total", value: money(ledgerTotal) },
                { label: "Balance Fwd", value: money(current?.balance_forward ?? 0) },
              ]}
            />
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5, minWidth: 680 }}>
                <thead>
                  <tr>
                    {["Bill", "Balance Fwd", "Electric", "Water", "Gas", "Other", "Non-MLGW", ""].map((h, i) => (
                      <th key={h || "inv"} style={{ textAlign: i === 0 || i === 7 ? "left" : "right", fontSize: 9, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: T.muted, padding: "9px 10px", borderBottom: `1px solid ${T.line}` }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.tree.map((node) => (
                    <LedgerRow key={node.bill.id} node={node} moveIn={detail.unit?.move_in_date ?? null} moveOut={detail.unit?.move_out_date ?? null} />
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Ledger Tree */}
          <Panel icon="🌿" title="Ledger Tree" subtitle="Bill and payment flow with balance forward tracking">
            <Strip
              items={[
                { label: "Bills", value: detail.bills.length },
                { label: "Payments", value: detail.payments.length },
                { label: "Billed", value: money(ledgerTotal) },
                { label: "Paid", value: money(paidTotal) },
              ]}
            />
            <div style={{ position: "relative", paddingLeft: 26 }}>
              <span style={{ content: '""', position: "absolute", left: 8, top: 8, bottom: 8, width: 1.5, background: T.line }} />
              {detail.tree.map((node) => (
                <TreeNode key={node.bill.id} node={node} selected={node.bill.id === current?.id} />
              ))}
            </div>
          </Panel>

          {/* Payments */}
          <Panel icon="💳" title="Account Payments" subtitle={`${detail.payments.length} payments saved for account ${account.account_number}`}>
            <Strip
              items={[
                { label: "Payments", value: detail.payments.length },
                { label: "Total Paid", value: money(paidTotal) },
                { label: "Latest", value: detail.payments[0]?.paid_date ? shortDate(detail.payments[0].paid_date) : "—" },
              ]}
            />
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5, minWidth: 560 }}>
                <thead>
                  <tr>
                    {["Status", "Paid", "Amount", "Method"].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 2 ? "right" : "left", fontSize: 9, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: T.muted, padding: "9px 10px", borderBottom: `1px solid ${T.line}` }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.payments.map((p, i) => (
                    <tr key={p.id}>
                      <td style={td(i === detail.payments.length - 1)}><Pill tone="processed">{p.status || "Processed"}</Pill></td>
                      <td style={td(i === detail.payments.length - 1)}>
                        <b style={NUM}>{shortDate(p.paid_date)}</b>
                        <br />
                        <span style={{ color: T.muted, fontSize: 10, ...NUM }}>#{p.reference_number}</span>
                      </td>
                      <td style={{ ...td(i === detail.payments.length - 1), textAlign: "right", fontWeight: 700, ...NUM }}>{money(p.amount)}</td>
                      <td style={td(i === detail.payments.length - 1)}>
                        {p.payment_method || "—"}
                        <br />
                        <span style={{ color: T.muted, fontSize: 10, ...NUM }}>
                          {p.authorization_number ? `Auth ${p.authorization_number}` : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {detail.payments.length === 0 ? (
                    <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: T.muted }}>No payments synced for this account.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function td(last: boolean): React.CSSProperties {
  return { padding: 10, borderBottom: last ? "none" : `1px solid ${T.line}`, verticalAlign: "top", color: T.ink };
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ background: "rgba(255,255,255,0.75)", border: `1px solid ${T.line}`, borderRadius: 8, padding: "5px 10px" }}>
      <span style={{ display: "block", fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: T.muted }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: T.ink, ...NUM }}>{value}</span>
    </span>
  );
}

function Tile({
  icon, tintBg, tintFg, label, value, caption,
}: {
  icon: string; tintBg: string; tintFg: string; label: string; value: React.ReactNode; caption: string;
}) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${T.line}`, borderRadius: 12, padding: 13, display: "flex", gap: 11, alignItems: "flex-start" }}>
      <span style={{ width: 30, height: 30, borderRadius: 15, background: tintBg, color: tintFg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>
        {icon}
      </span>
      <span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: T.muted }}>{label}</span>
        <div style={{ fontSize: 17, fontWeight: 800, margin: "1px 0", color: T.ink, ...NUM }}>{value}</div>
        <span style={{ fontSize: 9.5, color: T.muted, ...NUM }}>{caption}</span>
      </span>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: T.muted, fontWeight: 600, marginBottom: 2 }}>{k}</div>
      <div style={{ fontWeight: 700, color: T.ink, ...NUM }}>{v}</div>
    </div>
  );
}

function LedgerRow({ node, moveIn, moveOut }: { node: LedgerTreeNode; moveIn: string | null; moveOut: string | null }) {
  const b = node.bill;
  const after = !!moveIn && !!b.bill_date && b.bill_date > moveIn && (!moveOut || moveOut > b.bill_date);
  const cell = (v: number | null, key: string): React.ReactNode => (
    <td style={{ padding: 10, borderBottom: `1px solid ${T.line}`, textAlign: "right", fontWeight: 700, color: v ? SEGMENT_INK[key] ?? T.ink : T.muted, ...NUM }}>
      {v ? money(v) : "–"}
    </td>
  );
  return (
    <tr style={b.is_current ? { background: "rgba(180,181,58,0.06)" } : undefined}>
      <td style={{ padding: 10, borderBottom: `1px solid ${T.line}`, borderLeft: b.is_current ? `3px solid ${T.accent}` : undefined }}>
        <Pill tone={b.is_current ? "current" : "archived"}>{b.is_current ? "Current" : "Archived"}</Pill>
        <b style={{ marginLeft: 6, color: T.ink, ...NUM }}>{shortDate(b.bill_date)}</b>
        {after ? (
          <div style={{ fontSize: 10, fontWeight: 700, color: T.blocked, marginTop: 5 }}>👤 After tenant move-in on {shortDate(moveIn)}</div>
        ) : null}
      </td>
      {cell(b.balance_forward, "balfwd")}
      {cell(b.electric_total, "electric")}
      {cell((b.water_total ?? 0) + (b.sewer_total ?? 0) + (b.sewer_charge_total ?? 0) || null, "water")}
      {cell(b.gas_total, "gas")}
      {cell(b.other_mlgw_total, "other")}
      {cell(b.non_mlgw_total, "nonmlgw")}
      <td style={{ padding: 10, borderBottom: `1px solid ${T.line}` }}>
        {b.file_path ? (
          <a href={`/api/admin/utilities/invoice/${encodeURIComponent(b.id)}`} target="_blank" rel="noreferrer" aria-label="Open invoice">🧾</a>
        ) : (
          <span style={{ opacity: 0.35 }}>🧾</span>
        )}
      </td>
    </tr>
  );
}

function TreeNode({ node, selected }: { node: LedgerTreeNode; selected: boolean }) {
  const chips: Array<[string, React.ReactNode]> = [
    ["BILL", money(node.bill.amount_due)],
    ["BALANCE FWD", money(node.bill.balance_forward ?? 0)],
    ["NEW CHARGES", money(node.newCharges)],
    ["PAID BEFORE NEXT", node.paidBeforeNext > 0 ? money(node.paidBeforeNext) : "None"],
  ];
  return (
    <div style={{ position: "relative", padding: "10px 0 14px" }}>
      <span
        style={{
          position: "absolute", left: -22, top: 16, width: 8, height: 8, borderRadius: 4,
          background: selected ? T.accent : T.muted,
          boxShadow: selected ? "0 0 0 4px rgba(180,181,58,0.22)" : undefined,
        }}
      />
      <span style={{ fontSize: 12, fontWeight: 700, color: T.ink, ...NUM }}>{shortDate(node.bill.bill_date)}</span>
      <span style={{ fontSize: 10, color: T.muted, marginLeft: 8, ...NUM }}>#{node.bill.document_id}</span>
      {selected ? (
        <span style={{ fontSize: 9, fontWeight: 800, color: T.accentInk, background: "rgba(180,181,58,0.16)", borderRadius: 999, padding: "2px 8px", marginLeft: 8 }}>Selected</span>
      ) : null}
      <div style={{ display: "flex", gap: 8, margin: "8px 0 6px", flexWrap: "wrap" }}>
        {chips.map(([k, v]) => (
          <span key={k} style={{ background: T.wash, border: `1px solid ${T.line}`, borderRadius: 9, padding: "6px 11px" }}>
            <MicroLabel>{k}</MicroLabel>
            <span style={{ fontSize: 12, fontWeight: 800, color: T.ink, ...NUM }}>{v}</span>
          </span>
        ))}
      </div>
      {node.isLatest ? (
        <div style={{ fontSize: 11, color: T.muted, margin: "4px 0" }}>
          → Latest bill in this account ledger.{node.payments.length === 0 ? " No payments captured before the next bill." : ""}
        </div>
      ) : node.reconciles !== null ? (
        <div style={{ fontSize: 11, fontWeight: 600, margin: "4px 0", color: node.reconciles ? T.gasInk : T.blocked }}>
          {node.reconciles ? "✓ Payments line up with the next balance forward." : "✕ Payments do not match the next balance forward."}
        </div>
      ) : null}
      {node.payments.map((p) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, background: T.wash, borderRadius: 9, padding: "8px 12px", marginTop: 6, fontSize: 11.5 }}>
          💳 <b style={{ color: T.ink, ...NUM }}>{shortDate(p.paid_date)}</b>
          <span style={{ color: T.muted, ...NUM }}>#{p.reference_number}</span>
          <span style={{ marginLeft: "auto", fontWeight: 800, color: T.gasInk, ...NUM }}>{money(p.amount)}</span>
        </div>
      ))}
    </div>
  );
}

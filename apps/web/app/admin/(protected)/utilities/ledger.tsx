"use client";

import { useState } from "react";
import type { AccountSummary } from "@/lib/admin-utilities";
import { ChargeBar, NUM, Panel, SEGMENT_FILL, T, money, shortDate } from "./ui";

/**
 * The Ledger tab (artifact): All / Units / House filter chips with live
 * counts, then account rows — count-badged icon, address + account number,
 * DUE DATE column, and the right-side DUE NOW + slim charge bar + dot legend.
 * Rows open the account's bill sheet. Payables reuses the rows with status
 * grouping; Move-In Risk narrows to flagged accounts.
 */

type LedgerFilter = "all" | "units" | "house";

export function LedgerTab({
  summaries,
  onOpen,
}: {
  summaries: AccountSummary[];
  onOpen: (accountId: string) => void;
}) {
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const units = summaries.filter((s) => !s.account.is_house_account);
  const house = summaries.filter((s) => s.account.is_house_account);
  const visible = filter === "units" ? units : filter === "house" ? house : summaries;

  const chip = (key: LedgerFilter, label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      style={{
        display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11, fontWeight: 700,
        borderRadius: 9, padding: "6px 12px", cursor: "pointer",
        background: filter === key ? "rgba(180,181,58,0.18)" : "#fff",
        border: `1px solid ${filter === key ? "rgba(180,181,58,0.6)" : T.line}`,
        color: filter === key ? T.accentInk : T.muted,
      }}
    >
      {label} <span style={{ fontSize: 10, opacity: 0.8, ...NUM }}>{count}</span>
    </button>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 8, margin: "14px 0 0" }}>
        {chip("all", "☰ All", summaries.length)}
        {chip("units", "🏢 Units", units.length)}
        {chip("house", "🏠 House Accounts", house.length)}
      </div>
      <Panel padding={4}>
        {visible.map((s, i) => (
          <AccountRow key={s.account.id} summary={s} last={i === visible.length - 1} onOpen={onOpen} />
        ))}
        {visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: T.muted }}>
            No accounts synced yet — run the MLGW sync.
          </div>
        ) : null}
      </Panel>
    </>
  );
}

export function AccountRow({
  summary,
  last,
  onOpen,
  statusBadge,
}: {
  summary: AccountSummary;
  last: boolean;
  onOpen: (accountId: string) => void;
  statusBadge?: React.ReactNode;
}) {
  const { account } = summary;
  return (
    <button
      type="button"
      onClick={() => onOpen(account.id)}
      style={{
        display: "grid", gridTemplateColumns: "14px 48px minmax(0,1fr) 110px minmax(230px, 330px)",
        gap: 12, alignItems: "center", padding: "12px 14px", width: "100%", textAlign: "left",
        background: "transparent", border: "none", cursor: "pointer",
        borderBottom: last ? "none" : `1px solid ${T.line}`,
      }}
    >
      <span style={{ color: T.muted, fontSize: 10 }}>›</span>
      <span style={{ position: "relative", width: 42, height: 42, borderRadius: 11, background: T.wash, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>
        {account.is_house_account ? "🏠" : "🏢"}
        <span
          style={{
            position: "absolute", bottom: -5, left: -5, minWidth: 17, height: 16, borderRadius: 9,
            background: T.navy, border: "1px solid rgba(255,255,255,0.85)", color: "#fff",
            fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", ...NUM,
          }}
        >
          {summary.billCount}
        </span>
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.ink, display: "flex", alignItems: "center", gap: 8 }}>
          {account.service_address || account.account_number}
          {statusBadge}
        </span>
        <span style={{ fontSize: 10.5, color: T.muted, ...NUM }}>{account.account_number}</span>
      </span>
      <span>
        <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.09em", color: T.muted }}>DUE DATE</span>
        <br />
        <span style={{ fontSize: 12, fontWeight: 700, color: summary.pastDue ? T.blocked : T.ink, ...NUM }}>
          {shortDate(summary.dueDate)}
        </span>
      </span>
      <span style={{ textAlign: "right" }}>
        <span style={{ fontSize: 13.5, fontWeight: 800, color: summary.pastDue ? T.blocked : T.ink, ...NUM }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.muted, marginRight: 6, letterSpacing: "0.06em" }}>DUE NOW</span>
          {money(summary.dueNow)}
        </span>
        <span style={{ display: "block", margin: "5px 0 4px" }}>
          <ChargeBar segments={summary.segments} height={7} />
        </span>
        <span style={{ fontSize: 9.5, color: T.muted, display: "flex", gap: 9, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {summary.segments.map((s) => (
            <i key={s.key} style={{ fontStyle: "normal", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: SEGMENT_FILL[s.key] }} />
              {s.label} <b style={{ color: T.ink, ...NUM }}>{money(s.amount)}</b>
            </i>
          ))}
        </span>
      </span>
    </button>
  );
}

export function PayablesTab({
  summaries,
  onOpen,
}: {
  summaries: AccountSummary[];
  onOpen: (accountId: string) => void;
}) {
  const owing = summaries.filter((s) => s.dueNow > 0);
  const pastDue = owing.filter((s) => s.pastDue);
  const dueSoon = owing.filter((s) => s.dueSoon && !s.pastDue);
  const ready = owing.filter((s) => !s.pastDue && !s.dueSoon);
  const ordered = [...pastDue, ...dueSoon, ...ready];

  const pill = (label: string, count: number, color: string) => (
    <span style={{ fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "6px 13px", background: `${color}1A`, color }}>
      {label} <span style={NUM}>{count}</span>
    </span>
  );

  return (
    <Panel icon="✓" title="Payables" subtitle="Accounts with a balance, past due first">
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {pill("Ready", ready.length, T.ready)}
        {pill("Past Due", pastDue.length, T.blocked)}
        {pill("Due Soon", dueSoon.length, T.gasInk)}
      </div>
      {ordered.map((s, i) => (
        <AccountRow
          key={s.account.id}
          summary={s}
          last={i === ordered.length - 1}
          onOpen={onOpen}
          statusBadge={
            s.pastDue ? (
              <span style={{ fontSize: 9, fontWeight: 800, color: T.blocked, border: `1px solid ${T.blocked}55`, borderRadius: 7, padding: "2px 7px" }}>PAST DUE</span>
            ) : s.dueSoon ? (
              <span style={{ fontSize: 9, fontWeight: 800, color: T.gasInk, border: `1px solid ${T.gas}66`, borderRadius: 7, padding: "2px 7px" }}>DUE SOON</span>
            ) : undefined
          }
        />
      ))}
      {ordered.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: T.muted }}>Nothing owing right now.</div>
      ) : null}
    </Panel>
  );
}

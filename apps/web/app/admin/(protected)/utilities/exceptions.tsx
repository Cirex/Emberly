"use client";

import { useMemo } from "react";
import type { AccountSummary, UtilityException } from "@/lib/admin-utilities";
import { NUM, Panel, T, money, shortDate } from "./ui";

/**
 * The Action Items surface (artifact Exceptions tab): units grouped with a
 * colored severity rail — amber for electrical/spike, red for after-move-in —
 * each carrying its metric line and a Mark as Reviewed toggle, with Export
 * Report producing a CSV of the open items.
 */

const KIND_META: Record<
  UtilityException["kind"],
  { title: string; description: string; icon: string; tone: "amber" | "red" }
> = {
  high_electrical: {
    title: "High Electrical Spike",
    description: "Check HVAC, thermostat settings, lights, vacant-unit usage, and abnormal electrical usage.",
    icon: "⚡",
    tone: "amber",
  },
  spike: {
    title: "Bill Spike",
    description: "New charges are well above this account's history — verify usage and billing.",
    icon: "↗",
    tone: "amber",
  },
  billed_after_move_in: {
    title: "Billed After Move-In",
    description: "Verify tenant responsibility for utility usage billed after move-in.",
    icon: "👤",
    tone: "red",
  },
};

function toneColor(tone: "amber" | "red"): { rail: string; ink: string } {
  return tone === "red" ? { rail: T.blocked, ink: T.blocked } : { rail: T.gas, ink: T.gasInk };
}

export function ExceptionsTab({
  exceptions,
  summaries,
  onToggleReviewed,
}: {
  exceptions: UtilityException[];
  summaries: AccountSummary[];
  onToggleReviewed: (e: UtilityException) => void;
}) {
  const byAccount = useMemo(() => {
    const map = new Map<string, UtilityException[]>();
    for (const e of exceptions) {
      const list = map.get(e.accountId);
      if (list) list.push(e);
      else map.set(e.accountId, [e]);
    }
    return map;
  }, [exceptions]);
  const summaryById = useMemo(() => new Map(summaries.map((s) => [s.account.id, s])), [summaries]);

  const exportCsv = () => {
    const rows = [["Account", "Address", "Kind", "Bill date", "Document", "Amount", "Reviewed"]];
    for (const e of exceptions) {
      const s = summaryById.get(e.accountId);
      rows.push([
        s?.account.account_number ?? "",
        s?.account.service_address ?? "",
        KIND_META[e.kind].title,
        e.billDate ?? "",
        e.documentId,
        e.amount.toFixed(2),
        e.reviewed ? "yes" : "no",
      ]);
    }
    const csv = rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "utility-exceptions.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const reviewBtn = (e: UtilityException) => (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        onToggleReviewed(e);
      }}
      style={{
        fontSize: 10.5, fontWeight: 800, borderRadius: 999, padding: "6px 11px", whiteSpace: "nowrap", cursor: "pointer",
        border: `1px solid ${e.reviewed ? T.line : "rgba(180,181,58,0.55)"}`,
        color: e.reviewed ? T.muted : T.accentInk, background: e.reviewed ? T.wash : "#fff",
      }}
    >
      {e.reviewed ? "Reviewed ✓" : "✓ Mark as Reviewed"}
    </button>
  );

  return (
    <Panel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 10px" }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: T.ink }}>Action Items</span>
        <span style={{ fontSize: 11, color: T.muted, ...NUM }}>
          {byAccount.size} units / {exceptions.length} actions
        </span>
        <button
          type="button"
          onClick={exportCsv}
          style={{
            marginLeft: "auto", fontSize: 11, fontWeight: 800, color: T.accentInk, cursor: "pointer",
            border: "1px solid rgba(180,181,58,0.55)", borderRadius: 999, padding: "6px 13px", background: "#fff",
          }}
        >
          ⬆ Export Report
        </button>
      </div>

      {[...byAccount.entries()].map(([accountId, list]) => {
        const s = summaryById.get(accountId);
        const worst = list.some((e) => e.kind === "billed_after_move_in") ? "red" : "amber";
        const colors = toneColor(worst as "amber" | "red");
        const total = Math.max(...list.map((e) => e.amount));
        const headline = list[0];
        return (
          <div key={accountId} style={{ borderLeft: `3px solid ${colors.rail}`, borderRadius: 3, marginBottom: 4 }}>
            <div style={{ display: "grid", gridTemplateColumns: "18px 30px minmax(0,1fr) 90px 150px", gap: 12, alignItems: "center", padding: "12px 14px", background: "#fff" }}>
              <span style={{ color: T.muted, fontSize: 10 }}>▾</span>
              <span style={{ fontSize: 14, color: colors.ink }}>{KIND_META[headline.kind].icon}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{s?.account.service_address ?? accountId}</span>
                <br />
                <span style={{ fontSize: 10.5, color: T.muted, ...NUM }}>{s?.account.account_number}</span>
              </span>
              <span style={{ textAlign: "right", fontSize: 12.5, fontWeight: 800, color: T.ink, ...NUM }}>{money(total)}</span>
              {reviewBtn(headline)}
            </div>
            {list.map((e) => {
              const meta = KIND_META[e.kind];
              const tone = toneColor(meta.tone);
              return (
                <div
                  key={`${e.billId}-${e.kind}`}
                  style={{
                    display: "grid", gridTemplateColumns: "30px 130px minmax(0,1fr) 90px 150px", gap: 12,
                    alignItems: "center", padding: "12px 14px", background: "#FBFAF4",
                    borderLeft: `2px solid ${T.line}`, marginLeft: 26, borderRadius: 2,
                    opacity: e.reviewed ? 0.55 : 1,
                  }}
                >
                  <span style={{ fontSize: 14, color: tone.ink }}>{meta.icon}</span>
                  <span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.ink, ...NUM }}>{shortDate(e.billDate)}</span>
                    <br />
                    <span style={{ fontSize: 8.5, color: T.muted, letterSpacing: "0.04em", ...NUM }}>#{e.documentId}</span>
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: tone.ink }}>{meta.title}</span>
                    <div style={{ fontSize: 11, color: T.muted, margin: "2px 0" }}>{meta.description}</div>
                    {e.metricLine ? (
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: tone.ink, ...NUM }}>{e.metricLine}</span>
                    ) : null}
                  </span>
                  <span style={{ textAlign: "right", fontSize: 12.5, fontWeight: 800, color: T.ink, ...NUM }}>{money(e.amount)}</span>
                  {reviewBtn(e)}
                </div>
              );
            })}
          </div>
        );
      })}
      {exceptions.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: T.muted }}>
          No action items — every current bill looks normal.
        </div>
      ) : null}
    </Panel>
  );
}

"use client";

import { useMemo, useState } from "react";
import type {
  AccountSummary,
  CurrentMonthMix,
  MonthOverMonth,
  MonthPoint,
  UtilityException,
} from "@/lib/admin-utilities";
import { DetailSheet, type AccountDetail } from "./detail-sheet";
import { ExceptionsTab } from "./exceptions";
import { AccountRow, LedgerTab, PayablesTab } from "./ledger";
import { PortfolioSnapshot } from "./overview";
import { NUM, Panel, T } from "./ui";

/**
 * /admin/utilities client shell (approved artifact): the five XMS tabs over
 * a server-assembled payload. Review toggles apply optimistically and post
 * to the shared mlgw_exception_reviews checklist.
 */

export interface UtilitiesPayload {
  generatedAt: number;
  spendGoal: number | null;
  series: MonthPoint[];
  mix: CurrentMonthMix;
  mom: MonthOverMonth;
  summaries: AccountSummary[];
  exceptions: UtilityException[];
  details: Record<string, AccountDetail>;
}

const TABS = ["Overview", "Ledger", "Payables", "Exceptions", "Move-In Risk"] as const;
type Tab = (typeof TABS)[number];

export function UtilitiesClient({
  payload,
  initialError,
}: {
  payload: UtilitiesPayload | null;
  initialError: string;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);
  const [exceptions, setExceptions] = useState<UtilityException[]>(payload?.exceptions ?? []);

  const summaryById = useMemo(
    () => new Map((payload?.summaries ?? []).map((s) => [s.account.id, s])),
    [payload],
  );

  if (!payload) {
    return (
      <div style={{ padding: "40px 32px" }}>
        <div style={{ borderRadius: 12, border: `1px solid ${T.line}`, background: "#fff", padding: 32, textAlign: "center", color: T.muted, fontSize: 13 }}>
          {initialError || "Could not load utility data."}
        </div>
      </div>
    );
  }

  const toggleReviewed = async (e: UtilityException) => {
    const next = !e.reviewed;
    setExceptions((prev) =>
      prev.map((x) => (x.billId === e.billId && x.kind === e.kind ? { ...x, reviewed: next } : x)),
    );
    try {
      const res = await fetch("/api/admin/utilities/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billId: e.billId,
          accountNumber: summaryById.get(e.accountId)?.account.account_number,
          exceptionKind: e.kind,
          reviewed: next,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Roll back on failure — the checklist is shared with the manager app,
      // so a silent divergence would be worse than a bounced click.
      setExceptions((prev) =>
        prev.map((x) => (x.billId === e.billId && x.kind === e.kind ? { ...x, reviewed: e.reviewed } : x)),
      );
    }
  };

  const moveInRisk = payload.summaries.filter((s) =>
    exceptions.some((e) => e.accountId === s.account.id && e.kind === "billed_after_move_in"),
  );
  const openSummary = openAccountId ? summaryById.get(openAccountId) : undefined;
  const openDetail = openAccountId ? payload.details[openAccountId] : undefined;

  return (
    <div style={{ padding: "18px 24px 40px", color: T.ink }}>
      <div style={{ display: "flex", background: T.wash, borderRadius: 10, padding: 3, gap: 3, fontSize: 12, width: "fit-content" }}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: "6px 13px", borderRadius: 8, border: "none", cursor: "pointer", whiteSpace: "nowrap",
              fontWeight: tab === t ? 800 : 600, color: tab === t ? T.ink : T.muted,
              background: tab === t ? "#fff" : "transparent",
              boxShadow: tab === t ? "0 2px 6px rgba(27,37,95,0.14)" : undefined,
            }}
          >
            {t}
            {t === "Exceptions" && exceptions.some((e) => !e.reviewed) ? (
              <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: T.gasInk, ...NUM }}>
                {exceptions.filter((e) => !e.reviewed).length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "Overview" ? (
        <PortfolioSnapshot series={payload.series} goal={payload.spendGoal} mix={payload.mix} mom={payload.mom} />
      ) : null}
      {tab === "Ledger" ? <LedgerTab summaries={payload.summaries} onOpen={setOpenAccountId} /> : null}
      {tab === "Payables" ? <PayablesTab summaries={payload.summaries} onOpen={setOpenAccountId} /> : null}
      {tab === "Exceptions" ? (
        <ExceptionsTab exceptions={exceptions} summaries={payload.summaries} onToggleReviewed={toggleReviewed} />
      ) : null}
      {tab === "Move-In Risk" ? (
        <Panel icon="👤" title="Move-In Risk" subtitle="Accounts still billing the owner after a tenant moved in">
          {moveInRisk.map((s, i) => (
            <AccountRow
              key={s.account.id}
              summary={s}
              last={i === moveInRisk.length - 1}
              onOpen={setOpenAccountId}
              statusBadge={
                <span style={{ fontSize: 9, fontWeight: 800, color: T.blocked, border: `1px solid ${T.blocked}55`, borderRadius: 7, padding: "2px 7px" }}>
                  AFTER MOVE-IN
                </span>
              }
            />
          ))}
          {moveInRisk.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: T.muted }}>
              No owner-paid bills after a move-in — all clear.
            </div>
          ) : null}
        </Panel>
      ) : null}

      {openSummary && openDetail ? (
        <DetailSheet summary={openSummary} detail={openDetail} onClose={() => setOpenAccountId(null)} />
      ) : null}
    </div>
  );
}

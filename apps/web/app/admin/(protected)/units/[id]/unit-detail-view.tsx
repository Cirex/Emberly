"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  ResmanLeaseSummary,
  ResmanResidentSummary,
  ResmanTransactionSummary,
  ResmanUnitDetail,
  ResmanUnitFull,
  ResmanVehicle,
} from "@/lib/admin-resman-units";
import type { ResmanWorkOrderRow } from "@/lib/admin-resman-work-orders";
import { AdminButton } from "../../../_components/admin-ui";
import { fetchAdminJson } from "../../_components/admin-fetch";

import { UnitTagsSection } from "./unit-tags-section";

function money(n: number | null | undefined, cents = true): string {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}
function date(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : `${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function shortDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : `${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function text(s: string | null | undefined): string {
  return s == null || s === "" ? "—" : s;
}

function heroPill(o: ResmanUnitFull["occupancy_status"]): string {
  switch (o) {
    case "Occupied":
      return "bg-emerald-300/20 text-emerald-200";
    case "Notice":
      return "bg-amber-300/20 text-amber-200";
    default:
      return "bg-white/15 text-white/80";
  }
}

const OPEN_WO_STATUSES = new Set(["Not Started", "Scheduled", "In Progress"]);

function initialsOf(first: string | null, last: string | null): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  const init = `${f.charAt(0)}${l.charAt(0)}`.toUpperCase();
  return init || "?";
}

// MARK: - Hero

function Stat({ label, value, detail, tone }: { label: string; value: React.ReactNode; detail: string; tone?: "good" | "warn" }) {
  return (
    <div className="rounded-[10px] border border-white/[0.13] bg-white/[0.09] px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-white/50">{label}</p>
      <p
        className={`mt-0.5 text-[17px] font-bold tabular-nums leading-snug ${
          tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-white"
        }`}
      >
        {value}
      </p>
      <p className="text-[10.5px] text-white/55">{detail}</p>
    </div>
  );
}

// MARK: - Sections

function SectionCard({
  title,
  aside,
  children,
  flush,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-baseline justify-between px-5 pt-4">
        <h2 className="text-[13.5px] font-bold text-primary">{title}</h2>
        {aside ? <span className="text-xs font-semibold text-muted">{aside}</span> : null}
      </div>
      <div className={flush ? "mt-2" : "px-5 pb-5 pt-3"}>{children}</div>
    </section>
  );
}

function HouseholdCards({ residents }: { residents: ResmanResidentSummary[] }) {
  if (residents.length === 0) {
    return <p className="text-sm text-muted">No residents synced for this lease.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 min-[68.75rem]:grid-cols-3">
      {residents.map((r) => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown";
        const role = r.is_primary ? "Leaseholder" : r.household_status || "Occupant";
        const minor = /minor/i.test(r.household_status ?? "");
        const contact = [r.phone_numbers?.[0], r.email].filter(Boolean) as string[];
        return (
          <div key={r.resman_person_lease_id} className="rounded-[10px] border border-line bg-[var(--color-surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <span
                className={`grid h-8 w-8 flex-none place-items-center rounded-full text-[11px] font-extrabold text-white ${
                  r.is_primary
                    ? "bg-gradient-to-br from-primaryLight to-primary"
                    : minor
                      ? "bg-primary/20 text-primary"
                      : "bg-gradient-to-br from-[var(--color-accent-deep)] to-accent"
                }`}
              >
                {initialsOf(r.first_name, r.last_name)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold leading-tight text-textNavy">{name}</p>
                <p
                  className={`text-[10px] font-bold uppercase tracking-wide ${
                    r.is_primary ? "text-[var(--color-accent-deep)]" : "text-muted"
                  }`}
                >
                  {role}
                </p>
              </div>
            </div>
            <div className="mt-2 break-all text-[11.5px] leading-relaxed text-muted">
              {contact.length > 0 ? contact.map((c) => <span key={c} className="block">{c}</span>) : <span className="opacity-60">No contact on file</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function workOrderPill(status: string, reported: string | null): { cls: string; label: string } {
  if (status === "Completed" || status === "Closed") return { cls: "pill-ok", label: status };
  if (status === "Canceled") return { cls: "pill-neutral", label: status };
  const days = reported ? Math.max(0, Math.round((Date.now() - Date.parse(reported)) / 86_400_000)) : null;
  if (days != null && days >= 8) return { cls: days >= 31 ? "pill-crit" : "pill-warn", label: `${days}d open` };
  return { cls: "pill-neutral", label: status };
}

function WorkOrdersSection({ workOrders, unitNumber }: { workOrders: ResmanWorkOrderRow[]; unitNumber: string }) {
  const counts = {
    completed: workOrders.filter((w) => w.status === "Completed").length,
    closed: workOrders.filter((w) => w.status === "Closed").length,
    canceled: workOrders.filter((w) => w.status === "Canceled").length,
    open: workOrders.filter((w) => OPEN_WO_STATUSES.has(w.status)).length,
  };
  const total = workOrders.length;
  const recent = workOrders.slice(0, 8);
  const mix: Array<{ key: string; count: number; color: string; label: string }> = [
    { key: "completed", count: counts.completed, color: "var(--color-ok)", label: "completed" },
    { key: "closed", count: counts.closed, color: "#7BA88F", label: "closed" },
    { key: "canceled", count: counts.canceled, color: "#C9CCE0", label: "canceled" },
    { key: "open", count: counts.open, color: "var(--color-warn)", label: "open" },
  ].filter((m) => m.count > 0);

  return (
    <SectionCard
      title="Work orders"
      aside={
        total > 0 ? (
          <Link href={`/admin/work-orders?status=all&search=${encodeURIComponent(unitNumber)}`} className="hover:underline">
            all {total} ›
          </Link>
        ) : undefined
      }
      flush
    >
      {total === 0 ? (
        <p className="px-5 pb-5 pt-1 text-sm text-muted">No work orders synced for this unit.</p>
      ) : (
        <>
          <div className="mx-5 mt-1 flex h-2 overflow-hidden rounded-full">
            {mix.map((m) => (
              <span key={m.key} style={{ width: `${(m.count / total) * 100}%`, background: m.color }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 pb-1.5 pt-1.5 text-[11px] text-muted">
            {mix.map((m) => (
              <span key={m.key} className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[3px]" style={{ background: m.color }} />
                {m.count} {m.label}
              </span>
            ))}
          </div>
          <table className="admin-table">
            <tbody>
              {recent.map((w) => {
                const pill = workOrderPill(w.status, w.date_reported);
                return (
                  <tr key={w.resman_work_order_id}>
                    <td className="w-14 tabular-nums text-muted">{w.number || "—"}</td>
                    <td className="max-w-[280px]">
                      <span className="block truncate text-primary" title={w.title}>
                        {w.title || "—"}
                      </span>
                    </td>
                    <td>
                      <span className="whitespace-nowrap rounded-md bg-primary/[0.07] px-2 py-0.5 text-[11px] font-semibold text-primary">
                        {w.category || "Uncategorized"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap tabular-nums text-muted">
                      {shortDate(w.date_reported)}
                      {w.date_completed ? ` → ${shortDate(w.date_completed)}` : ""}
                    </td>
                    <td className="w-28">
                      <span className={`status-pill ${pill.cls}`}>
                        <span className="pill-dot" />
                        {pill.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </SectionCard>
  );
}

function LedgerSection({ transactions }: { transactions: ResmanTransactionSummary[] }) {
  return (
    <SectionCard title="Ledger" aside="running balance · newest first" flush>
      {transactions.length === 0 ? (
        <p className="px-5 pb-5 pt-1 text-sm text-muted">No ledger entries synced for this unit.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th className="text-right">Charge</th>
              <th className="text-right">Credit</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => {
              const settled = (t.balance ?? null) === 0;
              return (
                <tr key={t.resman_ledger_entry_id}>
                  <td className="whitespace-nowrap tabular-nums text-muted">{shortDate(t.date)}</td>
                  <td className={t.credits != null ? "font-semibold text-primary" : "text-primary"}>
                    {text(t.ledger_description || t.transaction_type)}
                  </td>
                  <td className="text-right tabular-nums text-[var(--color-crit)]">
                    {t.charges == null ? "" : money(t.charges)}
                  </td>
                  <td className="text-right tabular-nums text-[var(--color-ok)]">
                    {t.credits == null ? "" : `−${money(t.credits)}`}
                  </td>
                  <td
                    className={`text-right tabular-nums ${settled ? "font-bold text-[var(--color-ok)]" : "text-muted"}`}
                  >
                    {money(t.balance)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function LeaseHistory({ leases }: { leases: ResmanLeaseSummary[] }) {
  const router = useRouter();
  if (leases.length === 0) return null;
  return (
    <SectionCard title="Lease history" aside={`${leases.length} lease${leases.length === 1 ? "" : "s"}`} flush>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Start</th>
            <th>End</th>
            <th>Move-in</th>
            <th>Move-out</th>
            <th>Rent</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {leases.map((l) => (
            <tr
              key={l.resman_lease_id}
              onClick={() => router.push(`/admin/leases/${l.resman_lease_id}`)}
              className="cursor-pointer transition-colors hover:bg-primary/[0.03]"
            >
              <td className="font-medium text-primary">
                <span className="inline-flex items-center gap-1.5">
                  {text(l.status)}
                  <span aria-hidden className="text-primary/30">›</span>
                </span>
                {l.is_current_lease ? (
                  <span className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                    CURRENT
                  </span>
                ) : null}
              </td>
              <td className="tabular-nums text-muted">{shortDate(l.start_date)}</td>
              <td className="tabular-nums text-muted">{shortDate(l.end_date)}</td>
              <td className="tabular-nums text-muted">{shortDate(l.move_in_date)}</td>
              <td className="tabular-nums text-muted">{shortDate(l.move_out_date)}</td>
              <td className="tabular-nums text-primary">{money(l.resident_rent, false)}</td>
              <td className="tabular-nums text-primary">{money(l.balance, false)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionCard>
  );
}

// MARK: - Rail

function RailCard({ title, children, soft }: { title: string; children: React.ReactNode; soft?: boolean }) {
  return (
    <div className={`card px-4 py-3.5 ${soft ? "bg-[var(--color-surface-2)]" : ""}`}>
      <h3 className="mb-2 text-[12.5px] font-bold text-primary">{title}</h3>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px] text-[12.5px]">
      <span className="text-muted">{k}</span>
      <span className="text-right font-semibold tabular-nums text-textNavy">{v}</span>
    </div>
  );
}

function LeaseRail({ unit }: { unit: ResmanUnitFull }) {
  const start = unit.lease_start_date ? Date.parse(unit.lease_start_date) : null;
  const end = unit.lease_end_date ? Date.parse(unit.lease_end_date) : null;
  const now = Date.now();
  const pct = start != null && end != null && end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : null;
  const monthsTotal = start != null && end != null ? Math.max(1, Math.round((end - start) / (30.44 * 86_400_000))) : null;
  const monthsIn = pct != null && monthsTotal != null ? Math.min(monthsTotal, Math.max(1, Math.ceil(pct * monthsTotal))) : null;
  const daysLeft = end != null ? Math.max(0, Math.round((end - now) / 86_400_000)) : null;

  return (
    <RailCard title="Lease">
      <KV
        k="Status"
        v={
          <span className={`status-pill ${unit.lease_status === "Current" ? "pill-ok" : "pill-neutral"}`}>
            <span className="pill-dot" />
            {text(unit.lease_status)}
          </span>
        }
      />
      <KV k="Moved in" v={date(unit.move_in_date)} />
      {unit.move_out_date ? <KV k="Moved out" v={date(unit.move_out_date)} /> : null}
      <KV
        k="Term"
        v={
          unit.lease_start_date || unit.lease_end_date
            ? `${shortDate(unit.lease_start_date)} – ${shortDate(unit.lease_end_date)}`
            : "—"
        }
      />
      {unit.lease_term ? <KV k="Length" v={unit.lease_term} /> : null}
      {unit.leasing_agent ? <KV k="Agent" v={unit.leasing_agent} /> : null}
      {pct != null ? (
        <>
          <div className="mt-2 h-[7px] overflow-hidden rounded-full bg-primary/[0.08]">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-[var(--color-accent-deep)] to-accent"
              style={{ width: `${Math.round(pct * 100)}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[10.5px] text-muted">
            <span>
              {monthsIn} of {monthsTotal} months
            </span>
            <span>{daysLeft === 0 ? "ends today" : `renews in ${daysLeft} days`}</span>
          </div>
        </>
      ) : null}
    </RailCard>
  );
}

function FinancialsRail({ unit }: { unit: ResmanUnitFull }) {
  const loss =
    unit.market_rent != null && unit.lease_rent != null && unit.market_rent !== unit.lease_rent
      ? unit.lease_rent - unit.market_rent
      : null;
  return (
    <RailCard title="Financials">
      <KV k="Lease rent" v={money(unit.lease_rent)} />
      <KV k="Market rent" v={money(unit.market_rent)} />
      {loss != null ? (
        <KV
          k={loss < 0 ? "Loss to lease" : "Above market"}
          v={
            <span style={{ color: loss < 0 ? "var(--color-warn)" : "var(--color-ok)" }}>
              {loss < 0 ? "−" : "+"}
              {money(Math.abs(loss), false)} / mo
            </span>
          }
        />
      ) : null}
      <KV k="Deposit required" v={money(unit.deposit_required)} />
      <KV
        k="Deposit held"
        v={
          <span
            style={{
              color:
                unit.deposit_required != null && (unit.deposit_held ?? 0) < unit.deposit_required
                  ? "var(--color-crit)"
                  : undefined,
            }}
          >
            {money(unit.deposit_held)}
          </span>
        }
      />
      {unit.current_month_balance != null ? <KV k="Current month" v={money(unit.current_month_balance)} /> : null}
      <KV k="Times late" v={unit.times_late ?? "—"} />
      {unit.delinquency_reason ? <KV k="Delinquency" v={unit.delinquency_reason} /> : null}
    </RailCard>
  );
}

/**
 * Suspend / re-enable guest visits for the whole unit. Unlike the per-resident
 * ban this needs no enrolled login, so it works for households that never
 * registered — the gap that made never-logged-in tenants unbannable.
 */
type SuspendExpiryKind = "never" | "date" | "duration" | "move_out" | "status_change";

/**
 * The unit-tag expiry vocabulary, worded for a suspension. move_out leads
 * because it is nearly always what's meant: the ban belongs to the household
 * that earned it, not to the door.
 */
const SUSPEND_EXPIRY_OPTIONS: { kind: SuspendExpiryKind; label: string; hint: string }[] = [
  { kind: "move_out", label: "When tenant moves out", hint: "lifts when this lease ends" },
  { kind: "never", label: "Never", hint: "until lifted by hand" },
  { kind: "date", label: "On a date", hint: "lifts that day" },
  { kind: "duration", label: "After a set time", hint: "days from now" },
  { kind: "status_change", label: "When lease status changes", hint: "watches the current status" },
];

/** Plain-English rendering of the rule a live suspension is running under. */
function suspensionRule(ban: NonNullable<ResmanUnitDetail["unitBan"]>): string {
  switch (ban.expiry_kind) {
    case "move_out":
      return "⛓ Lifts automatically when this tenant moves out.";
    case "status_change":
      return `↻ Lifts when the lease leaves “${ban.status_trigger ?? "its current status"}”.`;
    case "date":
    case "duration": {
      if (!ban.expires_at) return "⏱ Expiring.";
      const days = Math.ceil((new Date(ban.expires_at).getTime() - Date.now()) / 86_400_000);
      return days <= 1 ? "⏱ Lifts today." : `⏱ Lifts in ${days} days (${date(ban.expires_at)}).`;
    }
    default:
      return "Stays until lifted by hand.";
  }
}

function GuestSuspendControl({ unit, unitBan }: { unit: ResmanUnitFull; unitBan: ResmanUnitDetail["unitBan"] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<SuspendExpiryKind>("move_out");
  const [expiresOn, setExpiresOn] = useState("");
  const [durationDays, setDurationDays] = useState("30");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function mutate(method: "POST" | "DELETE") {
    setLoading(true);
    setError("");
    try {
      await fetchAdminJson(`/api/admin/resman-units/${unit.resman_unit_id}/ban-guest-pass`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                reason,
                expiryKind: kind,
                ...(kind === "date" ? { expiresOn } : {}),
                ...(kind === "duration" ? { durationDays: Number(durationDays) } : {}),
              }),
            }
          : {}),
      });
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  if (unitBan) {
    const rule = suspensionRule(unitBan);
    return (
      <div className="mt-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2">
        <p className="text-[11px] leading-snug text-red-700">
          Guest visits suspended by <span className="font-semibold">{unitBan.banned_by}</span> on {date(unitBan.banned_at)}
          {unitBan.reason ? <> — {unitBan.reason}</> : null}. Passes can’t be created and existing ones are denied at the gate.
        </p>
        <p className="mt-1 text-[11px] font-semibold text-red-700/80">{rule}</p>
        {error ? <p className="mt-1 text-[11px] font-semibold text-red-700">{error}</p> : null}
        <AdminButton variant="ghost" className="mt-1.5" disabled={loading} onClick={() => void mutate("DELETE")}>
          {loading ? "Re-enabling…" : "Re-enable guest visits"}
        </AdminButton>
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      {open ? (
        <div className="rounded-lg border border-line bg-primary/[0.03] px-2.5 py-2">
          <p className="mb-1.5 text-[11px] leading-snug text-primary/70">
            Blocks new guest passes for everyone at this unit — enrolled or not — and denies existing passes at the gate.
          </p>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional, shown to the resident)"
            maxLength={500}
            className="mb-1.5 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-textNavy outline-none focus:border-primary/40"
          />
          {/* Same expiry vocabulary as unit tags, so the two can't drift: a
              "NO GUESTS ALLOWED" tag lifts at move-out and so should this. */}
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">Lifts</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SuspendExpiryKind)}
            className="mb-1.5 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-textNavy outline-none focus:border-primary/40"
          >
            {SUSPEND_EXPIRY_OPTIONS.map((o) => (
              <option key={o.kind} value={o.kind}>
                {o.label} — {o.hint}
              </option>
            ))}
          </select>
          {kind === "date" ? (
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              className="mb-1.5 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-textNavy outline-none focus:border-primary/40"
            />
          ) : null}
          {kind === "duration" ? (
            <input
              type="number"
              min={1}
              max={3650}
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              placeholder="Days"
              className="mb-1.5 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-textNavy outline-none focus:border-primary/40"
            />
          ) : null}
          {error ? <p className="mb-1.5 text-[11px] font-semibold text-red-700">{error}</p> : null}
          <div className="flex gap-2">
            <AdminButton variant="danger" disabled={loading} onClick={() => void mutate("POST")}>
              {loading ? "Suspending…" : "Suspend"}
            </AdminButton>
            <AdminButton variant="ghost" disabled={loading} onClick={() => setOpen(false)}>
              Cancel
            </AdminButton>
          </div>
        </div>
      ) : (
        <AdminButton variant="ghost" onClick={() => setOpen(true)}>
          Suspend guest visits…
        </AdminButton>
      )}
    </div>
  );
}

function UnitFactsRail({
  unit,
  vehicles,
  guestsAllowed,
  guestBans,
  unitBan,
}: {
  unit: ResmanUnitFull;
  vehicles: ResmanVehicle[];
  guestsAllowed: boolean;
  guestBans: number;
  unitBan: ResmanUnitDetail["unitBan"];
}) {
  const accessible = [
    unit.hearing_accessible ? "Hearing" : null,
    unit.mobility_accessible ? "Mobility" : null,
    unit.visual_accessible ? "Visual" : null,
  ].filter(Boolean) as string[];

  return (
    <RailCard title="Unit facts">
      <KV k="Classification" v={text(unit.classification)} />
      <KV k="Availability" v={text(unit.availability)} />
      <KV k="Floor" v={text(unit.floor)} />
      <KV k="Max occupancy" v={unit.max_occupancy ?? "—"} />
      <KV
        k="Guests allowed"
        v={
          <span style={{ color: guestsAllowed ? "var(--color-ok)" : "var(--color-crit)" }}>
            {guestsAllowed
              ? "Yes"
              : unitBan
                ? "No · unit suspended"
                : `No · ${guestBans} ban${guestBans === 1 ? "" : "s"}`}
          </span>
        }
      />
      <GuestSuspendControl unit={unit} unitBan={unitBan} />
      {unit.pets_permitted != null ? <KV k="Pets permitted" v={unit.pets_permitted ? "Yes" : "No"} /> : null}
      {accessible.length > 0 ? <KV k="Accessible" v={accessible.join(", ")} /> : null}
      {unit.affordable_unit ? <KV k="Affordable unit" v="Yes" /> : null}
      <div className="mt-2 border-t border-line pt-2.5">
        <p className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-primary/45">Vehicles on file</p>
        {vehicles.length === 0 ? (
          <p className="text-[12px] text-muted">None</p>
        ) : (
          <div className="grid gap-1.5">
            {vehicles.map((v) => (
              <p key={v.resman_vehicle_id} className="text-[12px] leading-snug text-textNavy">
                <span className="font-semibold">
                  {[v.year, v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle"}
                </span>
                {v.license_plate ? (
                  <span className="ml-1.5 rounded bg-primary/[0.07] px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-primary">
                    {v.license_plate}
                    {v.license_plate_state ? ` ${v.license_plate_state}` : ""}
                  </span>
                ) : null}
              </p>
            ))}
          </div>
        )}
      </div>
    </RailCard>
  );
}

// MARK: - View

export function UnitDetailView({ detail }: { detail: ResmanUnitDetail }) {
  const { unit, leases, transactions, workOrders, vehicles, guestsAllowed, guestBans } = detail;

  // Household = the current (else most recent) lease's residents with captured
  // identity; archived skeleton rows carry no name/contact and add nothing.
  const withIdentity = detail.residents.filter(
    (r) => r.first_name || r.last_name || r.email || (r.phone_numbers?.length ?? 0) > 0,
  );
  const homeLease = leases.find((l) => l.is_current_lease) ?? leases.find((l) => l.is_most_recent_lease) ?? leases[0];
  const household = homeLease
    ? withIdentity.filter((r) => r.resman_lease_id === homeLease.resman_lease_id)
    : withIdentity;
  const householdShown = household.length > 0 ? household : withIdentity;

  const openWorkOrders = workOrders.filter((w) => OPEN_WO_STATUSES.has(w.status)).length;
  const balance = unit.balance ?? transactions[0]?.balance ?? null;
  const lastPayment = transactions.find((t) => t.credits != null && (t.credits ?? 0) > 0);
  const addressLine = [
    unit.street,
    [unit.city, unit.state].filter(Boolean).join(", "),
    unit.postal_code,
    unit.floor ? `Floor ${unit.floor}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="admin-page">
      {/* Hero */}
      <div className="relative mb-4 overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-primaryLight px-6 pb-5 pt-5 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(180,181,58,.28), transparent 70%)" }}
        />
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <Link href="/admin/units" className="text-xs font-semibold text-white/55 hover:text-white">
              ‹ Units
            </Link>
            <h1 className="mt-1 flex flex-wrap items-center gap-3 text-[25px] font-bold leading-tight">
              Unit {text(unit.number)}
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold ${heroPill(unit.occupancy_status)}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {unit.occupancy_status ?? "Unknown"}
              </span>
              {unit.classification ? (
                <span className="rounded-full bg-white/[0.14] px-3 py-1 text-[11px] font-bold text-white/85">
                  {unit.classification}
                </span>
              ) : null}
              {unit.holding_unit ? (
                <span className="rounded-full bg-amber-300/20 px-3 py-1 text-[11px] font-bold text-amber-200">
                  Holding
                </span>
              ) : null}
            </h1>
            {addressLine ? <p className="mt-0.5 text-[13px] text-white/65">{addressLine}</p> : null}
          </div>
          <Link
            href="/admin/property-map"
            className="mt-1 inline-flex h-8 flex-none items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-bold text-primary transition-colors hover:bg-accent/90"
          >
            ◈ View on map
          </Link>
        </div>

        <div className="relative mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 min-[57.5rem]:grid-cols-6">
          <Stat label="Rent" value={money(unit.lease_rent, false)} detail={`market ${money(unit.market_rent, false)}`} />
          <Stat
            label="Balance"
            value={money(balance)}
            detail={lastPayment ? `paid ${shortDate(lastPayment.date)}` : "no payments synced"}
            tone={balance != null && balance <= 0 ? "good" : balance != null ? "warn" : undefined}
          />
          <Stat
            label="Layout"
            value={`${unit.bedrooms ?? "—"} bd · ${unit.bathrooms ?? "—"} ba`}
            detail={`max occupancy ${unit.max_occupancy ?? "—"}`}
          />
          <Stat
            label="Household"
            value={householdShown.length || "—"}
            detail={
              householdShown.length > 0
                ? `${householdShown.filter((r) => r.is_primary).length} leaseholder · ${householdShown.filter((r) => !r.is_primary).length} occupants`
                : "none synced"
            }
          />
          <Stat
            label="Open work orders"
            value={openWorkOrders}
            detail={`${workOrders.length} all-time`}
            tone={openWorkOrders > 0 ? "warn" : "good"}
          />
          <Stat
            label="Deposit"
            value={money(unit.deposit_held, false)}
            detail={`of ${money(unit.deposit_required, false)} required`}
          />
        </div>
      </div>

      {/* Body: main column + rail */}
      <div className="grid grid-cols-1 items-start gap-4 min-[60rem]:grid-cols-[1fr_300px] min-[75rem]:grid-cols-[1fr_320px]">
        <div className="grid gap-4">
          <SectionCard title="Household" aside={homeLease?.is_current_lease ? "current lease" : "most recent lease"}>
            <HouseholdCards residents={householdShown} />
          </SectionCard>
          <UnitTagsSection unitNumber={unit.number ?? ""} />
          <WorkOrdersSection workOrders={workOrders} unitNumber={unit.number ?? ""} />
          <LedgerSection transactions={transactions} />
          <LeaseHistory leases={leases} />
          {unit.notes ? (
            <SectionCard title="Notes">
              <p className="whitespace-pre-wrap text-sm text-primary">{unit.notes}</p>
            </SectionCard>
          ) : null}
        </div>

        <div className="grid gap-3">
          <LeaseRail unit={unit} />
          <FinancialsRail unit={unit} />
          <UnitFactsRail unit={unit} vehicles={vehicles} guestsAllowed={guestsAllowed} guestBans={guestBans} unitBan={detail.unitBan} />
          <RailCard title="Data freshness" soft>
            <KV k="Unit synced" v={unit.synced_at ? new Date(unit.synced_at).toLocaleString() : "never"} />
            <KV k="Deep scrape" v={unit.scraped_at ? new Date(unit.scraped_at).toLocaleString() : "—"} />
            <KV k="Source" v="ResMan · nightly" />
          </RailCard>
        </div>
      </div>
    </div>
  );
}

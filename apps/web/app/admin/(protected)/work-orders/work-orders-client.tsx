"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type {
  ResmanWorkOrderRow,
  WorkOrderStats,
  WorkOrderStatusFilter,
  WorkOrdersResult,
} from "@/lib/admin-resman-work-orders";

type Filters = {
  status: WorkOrderStatusFilter;
  category: string;
  technician: string;
  search: string;
  aging: boolean;
  page: number;
};

function buildUrl(f: Filters): string {
  const p = new URLSearchParams();
  if (f.status !== "open") p.set("status", f.status);
  if (f.category) p.set("category", f.category);
  if (f.technician) p.set("tech", f.technician);
  if (f.search.trim()) p.set("search", f.search.trim());
  if (f.aging) p.set("aging", "31plus");
  if (f.page > 1) p.set("page", String(f.page));
  const qs = p.toString();
  return `/admin/work-orders${qs ? `?${qs}` : ""}`;
}

function statusPill(status: string): string {
  switch (status) {
    case "Completed":
    case "Closed":
      return "pill-ok";
    case "In Progress":
    case "Scheduled":
      return "pill-warn";
    case "Canceled":
      return "pill-neutral";
    default: // Not Started
      return "pill-neutral";
  }
}

function ageDays(reported: string | null): number | null {
  if (!reported) return null;
  return Math.max(0, Math.round((Date.now() - Date.parse(reported)) / 86_400_000));
}

function AgeChip({ reported }: { reported: string | null }) {
  const days = ageDays(reported);
  if (days == null) return <span className="text-muted">—</span>;
  const tone =
    days >= 31
      ? "bg-[var(--color-crit-tint)] text-[var(--color-crit)]"
      : days >= 8
        ? "bg-[var(--color-warn-tint)] text-[var(--color-warn)]"
        : "bg-[var(--color-ok-tint)] text-[var(--color-ok)]";
  return (
    <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${tone}`}>
      {days}d
    </span>
  );
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function HBar({
  label,
  count,
  max,
  color,
}: {
  label: string;
  count: number;
  max: number;
  color?: string;
}) {
  const width = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
  return (
    <div className="grid grid-cols-[110px_1fr_40px] items-center gap-2 text-xs">
      <span className="truncate font-medium text-primary" title={label}>
        {label}
      </span>
      <span className="h-2 overflow-hidden rounded-full bg-primary/[0.08]">
        <span
          className="block h-full rounded-full"
          style={{ width: `${width}%`, background: color ?? "var(--color-primary-light)" }}
        />
      </span>
      <span className="text-right font-semibold tabular-nums text-muted">{count.toLocaleString()}</span>
    </div>
  );
}

function MonthlyChart({ monthly }: { monthly: WorkOrderStats["monthly"] }) {
  const max = Math.max(1, ...monthly.map((m) => m.count));
  return (
    <div className="flex h-28 items-end gap-1.5">
      {monthly.map((m) => (
        <div key={m.month} className="flex h-full flex-1 flex-col justify-end" title={`${m.month}: ${m.count}`}>
          <span
            className="block min-h-[2px] rounded-t-[3px]"
            style={{
              height: `${Math.round((m.count / max) * 100)}%`,
              background: m.partial
                ? "repeating-linear-gradient(45deg, var(--color-primary-light) 0 4px, #8E97CF 4px 8px)"
                : "var(--color-primary-light)",
            }}
          />
          <span className="mt-1 text-center text-[9px] leading-none text-muted">{m.label}</span>
        </div>
      ))}
    </div>
  );
}

const AGING_COLORS = [
  "var(--color-ok)",
  "var(--color-ok)",
  "var(--color-warn)",
  "var(--color-warn)",
  "var(--color-crit)",
];

function Kpi({
  label,
  value,
  detail,
  critical,
  active,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  critical?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`card px-4 py-3.5 text-left transition-shadow ${onClick ? "cursor-pointer hover:shadow-md" : "cursor-default"} ${
        critical ? "border-[#EAC7C2] bg-gradient-to-b from-white to-[var(--color-crit-tint)]" : ""
      } ${active ? "ring-2 ring-accent/60" : ""}`}
    >
      <p
        className={`text-[11px] font-semibold uppercase tracking-wide ${critical ? "text-[var(--color-crit)]/70" : "text-primary/45"}`}
      >
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums leading-tight ${critical ? "text-[var(--color-crit)]" : "text-primary"}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11.5px] text-muted">{detail}</p>
    </button>
  );
}

const STATUS_TABS: Array<{ key: WorkOrderStatusFilter; label: string }> = [
  { key: "open", label: "Open" },
  { key: "completed", label: "Completed" },
  { key: "canceled", label: "Canceled" },
  { key: "all", label: "All" },
];

export function WorkOrdersClient({
  result,
  photoCounts = {},
  status,
  category,
  technician,
  search,
  aging,
  page,
  initialError,
}: {
  result: WorkOrdersResult | null;
  /** Live completion-photo count per work order id (techs attach these on close). */
  photoCounts?: Record<string, number>;
  status: WorkOrderStatusFilter;
  category: string;
  technician: string;
  search: string;
  aging: boolean;
  page: number;
  initialError: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(search);
  const filters: Filters = { status, category, technician, search, aging, page };
  const go = (next: Partial<Filters>) => router.push(buildUrl({ ...filters, page: 1, ...next }));

  // Debounced search → URL (server re-renders), same pattern as the units list.
  useEffect(() => {
    const t = setTimeout(() => {
      if (query.trim() !== search.trim()) go({ search: query });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (initialError || !result) {
    return (
      <div className="admin-page">
        <div className="card px-5 py-4">
          <p className="text-sm font-semibold text-red-600">
            {initialError || "Failed to load work orders."}
          </p>
        </div>
      </div>
    );
  }

  const { orders, total, limit, stats, categoryOptions, technicianOptions } = result;
  const catMax = Math.max(1, ...stats.categories.map((c) => c.count));
  const techMax = Math.max(1, ...stats.technicians.map((t) => t.count));
  const agingMax = Math.max(1, ...stats.agingBuckets.map((b) => b.count));
  const showingFrom = total === 0 ? 0 : (page - 1) * limit + 1;
  const showingTo = Math.min(total, page * limit);
  const openQueue = status === "open";

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Property Management</p>
          <h1 className="text-2xl font-semibold text-primary">Work Orders</h1>
          <p className="mt-1 text-sm text-muted">
            {stats.total.toLocaleString()} synced from ResMan.
            {stats.lastSyncedAt ? ` Last sync ${new Date(stats.lastSyncedAt).toLocaleString()}.` : " Not yet synced."}
          </p>
        </div>
      </div>

      {/* KPIs — clicking one filters the queue below. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label="Open"
          value={stats.open.toLocaleString()}
          detail={`${stats.openNotStarted} not started · ${stats.openInProgress + stats.openScheduled} active`}
          active={openQueue && !aging}
          onClick={() => go({ status: "open", aging: false })}
        />
        <Kpi
          label="Aging 31+ days"
          value={stats.openAging31Plus.toLocaleString()}
          detail={`median open age ${stats.openMedianAgeDays ?? "—"} days`}
          critical
          active={aging}
          onClick={() => go({ status: "open", aging: true })}
        />
        <Kpi
          label="Median completion"
          value={stats.medianCompletionDays == null ? "—" : `${stats.medianCompletionDays}d`}
          detail={`p90 = ${stats.p90CompletionDays ?? "—"} days (${stats.completedCount.toLocaleString()} completed)`}
          active={status === "completed"}
          onClick={() => go({ status: "completed", aging: false })}
        />
        <Kpi
          label="Reported this month"
          value={stats.reportedThisMonth.toLocaleString()}
          detail={`last month: ${stats.reportedLastMonth.toLocaleString()}`}
        />
        <Kpi
          label="Callbacks flagged"
          value={stats.callbacksFlagged.toLocaleString()}
          detail="repeat-visit detector"
        />
      </div>

      {/* Charts */}
      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.35fr_1fr_1fr]">
        <div className="card px-4 py-3.5">
          <p className="text-[13px] font-bold text-primary">Reported per month</p>
          <p className="mb-3 text-[11.5px] text-muted">last 12 months · current month is partial</p>
          <MonthlyChart monthly={stats.monthly} />
        </div>
        <div className="card px-4 py-3.5">
          <p className="text-[13px] font-bold text-primary">Open by age</p>
          <p className="mb-3 text-[11.5px] text-muted">days since reported</p>
          <div className="grid gap-2">
            {stats.agingBuckets.map((b, i) => (
              <HBar key={b.label} label={b.label} count={b.count} max={agingMax} color={AGING_COLORS[i]} />
            ))}
          </div>
        </div>
        <div className="card px-4 py-3.5">
          <p className="text-[13px] font-bold text-primary">Top categories</p>
          <p className="mb-3 text-[11.5px] text-muted">all time · “Online” = resident-filed</p>
          <div className="grid gap-2">
            {stats.categories.map((c) => (
              <HBar key={c.name} label={c.name} count={c.count} max={catMax} />
            ))}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="admin-filter-bar">
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_TABS.map((t) => {
            const active = status === t.key && !aging;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => go({ status: t.key, aging: false })}
                className={`status-pill ${active ? "pill-accent" : "pill-neutral"} cursor-pointer`}
              >
                {t.label}
                {t.key === "open" ? ` · ${stats.open.toLocaleString()}` : ""}
              </button>
            );
          })}
          {aging ? (
            <button
              type="button"
              onClick={() => go({ aging: false })}
              className="status-pill pill-crit cursor-pointer"
              title="Clear the aging filter"
            >
              31+ days ✕
            </button>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <div className="admin-field">
            <label className="admin-label" htmlFor="wo-category">
              Category
            </label>
            <select
              id="wo-category"
              className="admin-select"
              value={category}
              onChange={(e) => go({ category: e.target.value })}
            >
              <option value="">All categories</option>
              {categoryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label className="admin-label" htmlFor="wo-tech">
              Technician
            </label>
            <select
              id="wo-tech"
              className="admin-select"
              value={technician}
              onChange={(e) => go({ technician: e.target.value })}
            >
              <option value="">All technicians</option>
              {technicianOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label className="admin-label" htmlFor="wo-search">
              Search
            </label>
            <input
              id="wo-search"
              className="admin-input w-full sm:w-56"
              placeholder="Title, unit, or WO #…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[2fr_1fr]">
        {/* Queue */}
        <div className="card overflow-x-auto">
          <div className="flex items-baseline justify-between px-5 pt-4">
            <p className="text-[13px] font-bold text-primary">
              {openQueue ? "Open queue" : "History"}
              <span className="ml-1.5 font-medium text-primary/40">
                ({total.toLocaleString()}{aging ? " aged 31+" : ""})
              </span>
            </p>
            <p className="text-xs text-muted">{openQueue ? "oldest first" : "newest first"}</p>
          </div>
          {orders.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted">
              {stats.total === 0
                ? "No work orders synced yet — the ResMan sync worker hasn't populated resman_work_orders."
                : "No work orders match this view."}
            </p>
          ) : (
            <table className="admin-table mt-2">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Unit</th>
                  <th>Issue</th>
                  <th>Category</th>
                  <th>Technician</th>
                  <th>Reported</th>
                  <th>{openQueue ? "Age" : "Done"}</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.resman_work_order_id}>
                    <td className="tabular-nums text-muted">{o.number || "—"}</td>
                    <td className="font-semibold text-primary">
                      {o.resman_unit_id ? (
                        <Link href={`/admin/units/${o.resman_unit_id}`} className="hover:underline">
                          {o.unit_number || "—"}
                        </Link>
                      ) : (
                        o.unit_number || "—"
                      )}
                    </td>
                    <td className="max-w-[300px]">
                      <span className="block truncate text-primary" title={o.title}>
                        {o.title || "—"}
                      </span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="whitespace-nowrap rounded-md bg-primary/[0.07] px-2 py-0.5 text-[11px] font-semibold text-primary">
                          {o.category || "Uncategorized"}
                        </span>
                        {o.is_make_ready ? (
                          <span className="whitespace-nowrap rounded-md bg-[var(--color-warn-tint)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-warn)]">
                            MAKE-READY
                          </span>
                        ) : null}
                        {o.callback_status === "possible" || o.callback_status === "confirmed" ? (
                          <span className="whitespace-nowrap rounded-md bg-[var(--color-crit-tint)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-crit)]">
                            CALLBACK
                          </span>
                        ) : null}
                        {photoCounts[o.resman_work_order_id] ? (
                          <span
                            className="whitespace-nowrap rounded-md bg-[var(--color-ok-tint)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-ok)]"
                            title="Completion photos attached by the technician"
                          >
                            {photoCounts[o.resman_work_order_id]}{" "}
                            {photoCounts[o.resman_work_order_id] === 1 ? "PHOTO" : "PHOTOS"}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-muted">{o.technician || "—"}</td>
                    <td className="whitespace-nowrap tabular-nums text-muted">{fmtDate(o.date_reported)}</td>
                    <td>
                      {o.date_completed ? (
                        <span className="whitespace-nowrap tabular-nums text-muted">{fmtDate(o.date_completed)}</span>
                      ) : (
                        <AgeChip reported={o.date_reported} />
                      )}
                    </td>
                    <td>
                      <span className={`status-pill ${statusPill(o.status)}`}>
                        <span className="pill-dot" />
                        {o.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {total > limit ? (
            <div className="flex items-center justify-between border-t border-primary/10 px-5 py-3.5">
              <p className="text-xs text-muted">
                Showing {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of {total.toLocaleString()}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => router.push(buildUrl({ ...filters, page: page - 1 }))}
                  className="pagination-btn"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={showingTo >= total}
                  onClick={() => router.push(buildUrl({ ...filters, page: page + 1 }))}
                  className="pagination-btn"
                >
                  Next
                </button>
              </div>
            </div>
          ) : (
            <p className="px-5 pb-4 pt-3 text-xs text-muted">
              Showing {orders.length.toLocaleString()} of {total.toLocaleString()}.
            </p>
          )}
        </div>

        {/* Side panels */}
        <div className="grid gap-3">
          <div className="card px-4 py-3.5">
            <div className="flex items-baseline justify-between">
              <p className="text-[13px] font-bold text-primary">Technician workload</p>
              <p className="text-[11px] text-muted">all time</p>
            </div>
            <div className="mt-3 grid gap-2">
              {stats.technicians.map((t) => (
                <HBar key={t.name} label={t.name} count={t.count} max={techMax} color="var(--color-accent-deep)" />
              ))}
            </div>
          </div>
          <div className="card overflow-hidden">
            <p className="px-4 pt-3.5 text-[13px] font-bold text-primary">Repeat units</p>
            <p className="px-4 text-[11.5px] text-muted">most work orders on file</p>
            <div className="mt-2">
              {stats.repeatUnits.map((u) => (
                <Link
                  key={u.unitNumber}
                  href={u.unitId ? `/admin/units/${u.unitId}` : "#"}
                  className="flex items-center justify-between border-t border-primary/[0.06] px-4 py-2.5 text-sm transition-colors hover:bg-primary/[0.03]"
                >
                  <span className="font-semibold text-primary">{u.unitNumber}</span>
                  <span className="tabular-nums text-muted">
                    {u.count} orders <span aria-hidden className="text-primary/30">›</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ResmanOccupancy, ResmanUnitRow, ResmanUnitsResult } from "@/lib/admin-resman-units";

const FILTERS: Array<{ key: ResmanOccupancy | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "Occupied", label: "Occupied" },
  { key: "Vacant", label: "Vacant" },
  { key: "Notice", label: "Notice" },
];

type Filters = {
  occupancy: ResmanOccupancy | "all";
  classification: string;
  hasBalance: boolean;
  search: string;
  page: number;
};

function buildUrl(f: Filters): string {
  const p = new URLSearchParams();
  if (f.occupancy !== "all") p.set("occupancy", f.occupancy);
  if (f.classification) p.set("class", f.classification);
  if (f.hasBalance) p.set("balance", "1");
  if (f.search.trim()) p.set("search", f.search.trim());
  if (f.page > 1) p.set("page", String(f.page));
  const qs = p.toString();
  return `/admin/units${qs ? `?${qs}` : ""}`;
}

function money(n: number | null, cents = false): string {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

function shortDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Classification chip tints — the leasing brand colors, softened for chips. */
const CLASS_CHIP: Record<string, string> = {
  ruby: "bg-[#F7E3E5] text-[#9C101F]",
  diamond: "bg-[#E3F0F8] text-[#2A7CB0]",
  legacy: "bg-[#F1EAE1] text-[#83674A]",
  lux: "bg-[#F8EFDC] text-[#A87E24]",
};

function ClassChip({ classification }: { classification: string }) {
  if (!classification) return null;
  const tone = CLASS_CHIP[classification.toLowerCase()] ?? "bg-primary/[0.07] text-primary";
  return (
    <span
      className={`ml-2 inline-block rounded-[5px] px-1.5 py-px align-[1px] text-[10px] font-extrabold uppercase tracking-wide ${tone}`}
    >
      {classification}
    </span>
  );
}

/**
 * Occupancy + lease status collapse into one cell: eviction and notice lead
 * with their own pills (they're the actionable states), everything else shows
 * plain occupancy, with the lease status as a sub-line when it adds anything.
 */
function statusOf(u: ResmanUnitRow): { pill: string; label: string; sub?: string } {
  if (u.lease_status === "Under Eviction") return { pill: "pill-crit", label: "Under Eviction" };
  if (u.lease_status === "Notice to Vacate") return { pill: "pill-warn", label: "Notice to Vacate" };
  switch (u.occupancy_status) {
    case "Occupied":
      return { pill: "pill-ok", label: "Occupied" };
    case "Notice":
      return { pill: "pill-warn", label: "Notice" };
    case "Vacant":
      return {
        pill: "pill-neutral",
        label: "Vacant",
        sub: u.lease_status === "Pending" ? "lease pending" : undefined,
      };
    default:
      return { pill: "pill-neutral", label: "Unknown" };
  }
}

function HouseholdCell({ u }: { u: ResmanUnitRow }) {
  const names = u.tenant_names ?? [];
  if (names.length === 0) return <span className="text-muted">—</span>;
  // "(Bankruptcy)" style annotations become a flag instead of stretching the name.
  const bankruptcy = names.some((n) => /bankrupt/i.test(n));
  const primary = names[0].replace(/\s*\([^)]*\)/g, "").trim() || names[0];
  const incoming = u.occupancy_status === "Vacant";
  return (
    <span className="whitespace-nowrap">
      <span className="text-primary">{primary}</span>
      {names.length > 1 ? <span className="ml-1.5 text-muted">+{names.length - 1}</span> : null}
      {incoming ? <span className="ml-1.5 text-muted">incoming</span> : null}
      {bankruptcy ? (
        <span className="ml-1.5 rounded bg-[var(--color-crit-tint)] px-1 py-px align-[1px] text-[9.5px] font-extrabold tracking-wide text-[var(--color-crit)]">
          BK
        </span>
      ) : null}
    </span>
  );
}

export function UnitsClient({
  result,
  occupancy,
  classification,
  hasBalance,
  search,
  page,
  initialError,
}: {
  result: ResmanUnitsResult | null;
  occupancy: ResmanOccupancy | "all";
  classification: string;
  hasBalance: boolean;
  search: string;
  page: number;
  initialError: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(search);
  const filters: Filters = { occupancy, classification, hasBalance, search, page };
  const go = (next: Partial<Filters>) => router.push(buildUrl({ ...filters, page: 1, ...next }));

  // Debounced search → URL (server re-renders).
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
          <p className="text-sm font-semibold text-red-600">{initialError || "Failed to load units."}</p>
        </div>
      </div>
    );
  }

  const { units, total, limit, stats, classificationOptions } = result;
  // Rentable stock, not every row: holding units and units flagged out of the
  // occupancy count are not vacant apartments waiting to be leased.
  const pct = (n: number) => (stats.rentable > 0 ? (n / stats.rentable) * 100 : 0);
  const showingFrom = total === 0 ? 0 : (page - 1) * limit + 1;
  const showingTo = Math.min(total, page * limit);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Property Management</p>
          <h1 className="text-2xl font-semibold text-primary">Units</h1>
          <p className="mt-1 text-sm text-muted">
            Synced from ResMan.
            {stats.lastSyncedAt ? ` Last sync ${new Date(stats.lastSyncedAt).toLocaleString()}.` : " Not yet synced."}
          </p>
        </div>
      </div>

      {/* Stats + occupancy mix */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 min-[57.5rem]:grid-cols-[repeat(4,1fr)_1.35fr]">
        {[
          {
            label: "Total",
            value: stats.total,
            // Says which number the percentages below are actually out of.
            detail:
              stats.rentable === stats.total
                ? `across ${stats.streets} streets`
                : `${stats.rentable.toLocaleString()} rentable · ${stats.streets} streets`,
          },
          { label: "Occupied", value: stats.occupied, detail: `${pct(stats.occupied).toFixed(1)}% of rentable`, color: "var(--color-ok)" },
          { label: "Vacant", value: stats.vacant, detail: `${pct(stats.vacant).toFixed(1)}% of rentable` },
          { label: "Notice", value: stats.notice, detail: "of the occupied, incl. evictions", color: "var(--color-warn)" },
        ].map((s) => (
          <div key={s.label} className="card px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-primary/45">{s.label}</p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums" style={{ color: s.color ?? "var(--color-primary)" }}>
              {s.value.toLocaleString()}
            </p>
            <p className="text-[11px] text-muted">{s.detail}</p>
          </div>
        ))}
        <div className="card px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary/45">Occupancy mix</p>
          {/*
            Occupied and vacant partition the rentable stock, so the bar sums to
            100%. Notice is drawn INSIDE the occupied segment rather than beside
            it: those households are still in the apartment, and giving them
            their own segment counted them twice and pushed the bar past full.
          */}
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full">
            {/*
              Notice sits at the RIGHT of the occupied run, against the vacant
              boundary — it is the occupied stock on its way out. On the left it
              took the bar's rounded end cap and read as a leading bucket of its
              own, which is the reading this nesting exists to prevent.
            */}
            <span className="flex justify-end" style={{ width: `${pct(stats.occupied)}%`, background: "var(--color-ok)" }}>
              <span
                style={{
                  width: `${stats.occupied > 0 ? (stats.notice / stats.occupied) * 100 : 0}%`,
                  background: "var(--color-warn)",
                }}
              />
            </span>
            <span style={{ width: `${pct(stats.vacant)}%`, background: "#C9CCE0" }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[3px]" style={{ background: "var(--color-ok)" }} /> occupied
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[3px]" style={{ background: "var(--color-warn)" }} /> on notice
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[3px]" style={{ background: "#C9CCE0" }} /> vacant
            </span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="admin-filter-bar">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => {
            const active = occupancy === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => go({ occupancy: f.key })}
                className={`status-pill cursor-pointer ${active ? "bg-primary text-white" : "pill-neutral"}`}
              >
                {f.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => go({ hasBalance: !hasBalance })}
            className={`status-pill cursor-pointer border border-dashed ${
              hasBalance ? "pill-crit border-[var(--color-crit)]" : "pill-neutral border-primary/25"
            }`}
            title="Only units carrying a balance, sorted highest first"
          >
            Has balance · {stats.withBalance.toLocaleString()}
          </button>
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <div className="admin-field">
            <label className="admin-label" htmlFor="unit-class">
              Classification
            </label>
            <select
              id="unit-class"
              className="admin-select"
              value={classification}
              onChange={(e) => go({ classification: e.target.value })}
            >
              <option value="">All classifications</option>
              {classificationOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label className="admin-label" htmlFor="unit-search">
              Search
            </label>
            <input
              id="unit-search"
              className="admin-input w-full sm:w-56"
              placeholder="Unit or tenant…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {units.length === 0 ? (
        <div className="card px-5 py-12 text-center">
          <p className="text-sm text-muted">
            {stats.total === 0
              ? "No units synced yet — the ResMan sync worker hasn't populated resman_units."
              : "No units match this view."}
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Status</th>
                <th>Household</th>
                <th>Layout</th>
                <th className="text-right">Rent</th>
                <th className="text-right">Balance</th>
                <th>Lease ends</th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {units.map((u) => {
                const status = statusOf(u);
                // Vacant units carry lease_rent = 0 — that's "no lease", not a rent.
                const rent = u.lease_rent || u.market_rent;
                const showMarket =
                  (u.lease_rent ?? 0) > 0 && u.market_rent != null && u.lease_rent !== u.market_rent;
                const owes = (u.balance ?? 0) > 0;
                const ended = u.lease_end_date != null && u.lease_end_date < today;
                return (
                  <tr
                    key={u.resman_unit_id}
                    onClick={() => router.push(`/admin/units/${u.resman_unit_id}`)}
                    className="cursor-pointer transition-colors hover:bg-primary/[0.03]"
                  >
                    <td className="whitespace-nowrap">
                      <span className="text-[13.5px] font-bold text-primary">{u.number || "—"}</span>
                      <ClassChip classification={u.classification} />
                    </td>
                    <td>
                      <span className={`status-pill ${status.pill}`}>
                        <span className="pill-dot" />
                        {status.label}
                      </span>
                      {status.sub ? <span className="mt-0.5 block text-[11px] text-muted">{status.sub}</span> : null}
                    </td>
                    <td>
                      <HouseholdCell u={u} />
                    </td>
                    <td className="whitespace-nowrap text-muted">
                      {u.bedrooms ?? "—"} bd · {u.bathrooms ?? "—"} ba
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums text-primary">
                      {money(rent)}
                      {showMarket ? (
                        <span className="block text-[11px] text-muted">market {money(u.market_rent)}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {owes ? (
                        <>
                          <span className="font-bold text-[var(--color-crit)]">{money(u.balance, true)}</span>
                          {(u.times_late ?? 0) > 0 ? (
                            <span className="block text-[11px] text-muted">{u.times_late}× late</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted">{u.balance == null ? "—" : money(u.balance, true)}</span>
                      )}
                    </td>
                    <td className={`whitespace-nowrap tabular-nums ${ended ? "text-[var(--color-crit)]" : "text-muted"}`}>
                      {ended ? `ended ${shortDate(u.lease_end_date)}` : shortDate(u.lease_end_date)}
                    </td>
                    <td aria-hidden className="text-primary/30">
                      ›
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {total > limit ? (
            <div className="flex items-center justify-between border-t border-primary/10 px-5 py-3.5">
              <p className="text-xs text-muted">
                Showing {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of {total.toLocaleString()}
                {hasBalance ? " · highest balance first" : ""}
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
              Showing {units.length.toLocaleString()} of {total.toLocaleString()}
              {hasBalance ? " · highest balance first" : ""}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

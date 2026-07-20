import type { ReactNode } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { notFound } from "next/navigation";
import { formatUnitForColumn } from "@/lib/admin-data";
import { getScannerActivity } from "@/lib/admin-scanner-activity";
import { AdminIcon } from "../../../_components/admin-ui";
import { healthPillClass } from "../../_components/pills";
import { ScannerKeySection } from "../_components/scanner-key-section";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ scannerId: string }>;
  searchParams?: Promise<{ days?: string | string[] }>;
};

function parseDays(value?: string | string[]): number {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "30" ? 30 : raw === "1" ? 1 : 7;
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-primary/10 bg-primary/[0.02] p-4">
      <p className="admin-kicker text-muted">{label}</p>
      <div className="mt-2 text-2xl font-bold tabular-nums text-primary">{value}</div>
      {sub ? <p className="mt-1 text-xs text-primary/45">{sub}</p> : null}
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="flex items-center gap-2 font-medium text-primary/75">
          <span className="h-2.5 w-2.5 rounded-xs" style={{ background: color }} />
          {label}
        </span>
        <span className="tabular-nums text-primary/50">
          {value} · {pct}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-primary/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export default async function ScannerActivityPage({ params, searchParams }: PageProps) {
  const { scannerId } = await params;
  const days = parseDays((await searchParams)?.days);

  const activity = await getScannerActivity(scannerId, days);
  if (!activity) notFound();

  const { scanner, perDay, todayTotal, windowTotal, residentTotal, guestTotal, recent } = activity;
  const maxDay = Math.max(1, ...perDay.map((d) => d.resident + d.guest));
  const windowLabel = days === 1 ? "today" : days === 30 ? "last 30 days" : "last 7 days";
  const avgPerDay = Math.round(windowTotal / days);

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Scanner · {scanner.scanner_id}</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">{scanner.name}</h1>
          <p className="mt-1 text-sm text-primary/55">
            {scanner.location ?? "No location set"}
            {scanner.last_seen_at
              ? ` · last seen ${format(new Date(scanner.last_seen_at), "MMM d, h:mm a")}`
              : " · never seen"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin/scanners" className="btn-ghost">
            <AdminIcon name="arrow-left" />
            <span>All scanners</span>
          </Link>
          <div className="inline-flex overflow-hidden rounded-lg border border-primary/15">
            {[
              { label: "Today", value: 1 },
              { label: "7 days", value: 7 },
              { label: "30 days", value: 30 },
            ].map((option) => (
              <Link
                key={option.value}
                href={`/admin/scanners/${scanner.scanner_id}?days=${option.value}`}
                className={`px-3 py-2 text-xs font-semibold transition-colors ${
                  days === option.value
                    ? "bg-primary text-white"
                    : "text-primary/60 hover:bg-primary/5"
                }`}
              >
                {option.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-6">
        <ScannerKeySection
          scannerId={scanner.scanner_id}
          scannerName={scanner.name}
          rotatedAt={scanner.secret_rotated_at ?? null}
        />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-primary/10 bg-primary/[0.02] p-4">
          <p className="admin-kicker text-muted">Health</p>
          <div className="mt-2">
            <span className={`health-pill ${healthPillClass(scanner.health.severity)}`}>
              {scanner.health.label}
            </span>
          </div>
          <p className="mt-2 text-xs text-primary/45">{scanner.health.detail}</p>
        </div>
        <Tile
          label="Scans today"
          value={todayTotal}
          sub={`${activity.todayResident} residents · ${activity.todayGuest} guests`}
        />
        <Tile label={days === 1 ? "Today" : days === 30 ? "This month" : "This week"} value={windowTotal} sub={`avg ${avgPerDay} / day`} />
        <div className="rounded-xl border border-accent/40 bg-accent/10 p-4">
          <p className="admin-kicker text-muted">State</p>
          <div className="mt-2">
            <span className={`status-pill ${scanner.enabled ? "pill-ok" : "pill-neutral"}`}>
              <span className="pill-dot" />
              {scanner.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p className="mt-2 text-xs text-primary/50">
            {scanner.secret_rotated_at
              ? `Secret rotated ${format(new Date(scanner.secret_rotated_at), "MMM d")}`
              : "Secret not issued"}
          </p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-primary">Scans over time</h2>
              <p className="mt-1 text-xs text-primary/45">Verified entries, {windowLabel}</p>
            </div>
            <div className="flex items-center gap-3 text-[11.5px] text-primary/50">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-xs bg-primary" />
                Residents
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-xs bg-accent" />
                Guests
              </span>
            </div>
          </div>
          {windowTotal === 0 ? (
            <div className="rounded-lg border border-primary/10 bg-primary/[0.03] px-4 py-10 text-center text-sm text-primary/45">
              No scans recorded in this period.
            </div>
          ) : (
            <div className="flex h-40 items-end gap-3">
              {perDay.map((day) => {
                const total = day.resident + day.guest;
                const heightPct = Math.round((total / maxDay) * 100);
                const residentPct = total > 0 ? Math.round((day.resident / total) * 100) : 0;
                return (
                  <div key={day.key} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                    <span className="text-[10.5px] font-semibold tabular-nums text-primary/45">{total}</span>
                    <div
                      className="flex w-full flex-col overflow-hidden rounded-t-md"
                      style={{ height: `${Math.max(heightPct, total > 0 ? 4 : 0)}%` }}
                    >
                      <div className="w-full bg-accent" style={{ height: `${100 - residentPct}%` }} />
                      <div className="w-full bg-primary" style={{ height: `${residentPct}%` }} />
                    </div>
                    <span className="text-[11px] text-primary/45">{day.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card p-5">
          <h2 className="mb-1 font-semibold text-primary">Who came through</h2>
          <p className="mb-4 text-xs text-primary/45">Resident vs guest, {windowLabel}</p>
          <div className="space-y-3.5">
            <BreakdownRow label="Residents" value={residentTotal} total={windowTotal} color="var(--color-primary)" />
            <BreakdownRow label="Guests" value={guestTotal} total={windowTotal} color="var(--color-accent)" />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-primary/10 pt-4 text-xs">
            <span className="text-primary/50">Busiest hour</span>
            <span className="font-semibold text-primary">{activity.busiestHourLabel ?? "—"}</span>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="admin-card-header">
          <div>
            <h2 className="admin-card-title">Scan log</h2>
            <p className="admin-card-subtitle">Everyone this scanner let in, newest first</p>
          </div>
          <Link href="/admin/entry-logs" className="admin-action-link">
            <span>Full entry logs</span>
            <AdminIcon name="chevron-right" />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Unit</th>
                <th>Type</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty-state-cell">
                    No scans recorded yet
                  </td>
                </tr>
              ) : (
                recent.map((scan) => (
                  <tr key={scan.id}>
                    <td>
                      {scan.resident_id ? (
                        <Link
                          href={`/admin/residents/${scan.resident_id}`}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {scan.tenant_name}
                        </Link>
                      ) : (
                        <span className="font-medium text-primary">{scan.tenant_name}</span>
                      )}
                    </td>
                    <td className="text-primary/70">{formatUnitForColumn(scan.unit_address)}</td>
                    <td>
                      <span
                        className={`status-pill capitalize ${
                          scan.entry_type === "resident" ? "pill-info" : "pill-accent"
                        }`}
                      >
                        <span className="pill-dot" />
                        {scan.entry_type}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-primary/55 tabular-nums">
                      {format(new Date(scan.entered_at), "MMM d, h:mm a")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

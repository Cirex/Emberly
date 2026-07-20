import { formatUnitForColumn } from "@/lib/admin-data";
import { format } from "date-fns";
import { AdminCardHeader, AdminIcon } from "../_components/admin-ui";
import { getAdminStats, type AdminStats } from "@/lib/admin-stats";
import { getScannerNameMap } from "@/lib/admin-scanners";

export const dynamic = "force-dynamic";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}

function StatCard({ label, value, sub, accent }: StatCardProps) {
  return (
    <div className={`card p-5 ${accent ? "bg-primary text-cream shadow-primary/10" : ""}`}>
      <p className={`admin-kicker mb-2 ${accent ? "text-cream/60" : ""}`}>
        {label}
      </p>
      <p className={`text-3xl font-bold tabular-nums ${accent ? "text-cream" : "text-primary"}`}>
        {value}
      </p>
      {sub && (
        <p className={`mt-2 text-xs leading-relaxed ${accent ? "text-cream/55" : "text-primary/45"}`}>
          {sub}
        </p>
      )}
    </div>
  );
}

// Simple SVG bar chart for entries by type today
function EntryBreakdown({ resident, guest }: { resident: number; guest: number }) {
  const total = resident + guest;
  if (total === 0) {
    return (
      <div className="rounded-lg border border-primary/10 bg-primary/[0.03] px-4 py-8 text-center">
        <p className="text-sm font-medium text-primary/55">No entries today</p>
        <p className="mt-1 text-xs text-primary/40">Security scans will appear here.</p>
      </div>
    );
  }

  const residentPct = Math.round((resident / total) * 100);
  const guestPct = 100 - residentPct;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex justify-between text-xs mb-1 text-primary/60">
          <span>Residents</span>
          <span>
            {resident} ({residentPct}%)
          </span>
        </div>
        <div className="h-2 bg-primary/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full"
            style={{ width: `${residentPct}%` }}
          />
        </div>
      </div>
      <div>
        <div className="flex justify-between text-xs mb-1 text-primary/60">
          <span>Guests</span>
          <span>
            {guest} ({guestPct}%)
          </span>
        </div>
        <div className="h-2 bg-accent/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full"
            style={{ width: `${guestPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function WeekChart({ byDay }: { byDay: AdminStats["byDay"] }) {
  const max = Math.max(1, ...byDay.map((d) => d.total));
  return (
    <div className="mb-5 flex h-32 items-end gap-2.5">
      {byDay.map((d) => {
        const heightPct = Math.round((d.total / max) * 100);
        const residentPct = d.total > 0 ? Math.round((d.resident / d.total) * 100) : 0;
        return (
          <div key={d.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="text-[10.5px] font-semibold tabular-nums text-primary/45">{d.total}</span>
            <div
              className="flex w-full flex-col overflow-hidden rounded-t-md"
              style={{ height: `${Math.max(heightPct, d.total > 0 ? 4 : 0)}%` }}
            >
              <div className="w-full bg-accent" style={{ height: `${100 - residentPct}%` }} />
              <div className="w-full bg-primary" style={{ height: `${residentPct}%` }} />
            </div>
            <span className="text-[11px] text-primary/45">{format(new Date(d.date), "EEE")}</span>
          </div>
        );
      })}
    </div>
  );
}

function ActivityPanel({
  week,
  month,
  created,
  used,
}: {
  week: number;
  month: number;
  created: number;
  used: number;
}) {
  const unused = Math.max(created - used, 0);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border border-primary/10 bg-primary/[0.03] p-4">
        <p className="admin-kicker">This Week</p>
        <p className="mt-2 text-2xl font-bold tabular-nums text-primary">{week}</p>
        <p className="mt-1 text-xs text-primary/45">entry scans</p>
      </div>
      <div className="rounded-lg border border-primary/10 bg-primary/[0.03] p-4">
        <p className="admin-kicker">This Month</p>
        <p className="mt-2 text-2xl font-bold tabular-nums text-primary">{month}</p>
        <p className="mt-1 text-xs text-primary/45">entry scans</p>
      </div>
      <div className="rounded-lg border border-accent/40 bg-accent/10 p-4">
        <p className="admin-kicker">Open Passes</p>
        <p className="mt-2 text-2xl font-bold tabular-nums text-primary">{unused}</p>
        <p className="mt-1 text-xs text-primary/50">created in the last 30 days</p>
      </div>
    </div>
  );
}

export default async function AdminDashboard() {
  const [data, scannerNames] = await Promise.all([getAdminStats(), getScannerNameMap()]);

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Operations</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Dashboard</h1>
        </div>
        <p className="text-sm font-medium text-muted">
          {format(new Date(), "EEEE, MMMM d, yyyy")}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Residents"
          value={data.residents.total}
          sub="Created by successful ResMan logins"
          accent
        />
        <StatCard label="Guest Passes" value={data.guestPasses.total} sub="All created passes" />
        <StatCard label="Entries Today" value={data.today.total} sub={`${data.today.resident} residents · ${data.today.guest} guests`} />
        <StatCard
          label="Pass Usage Rate"
          value={`${data.guestPasses.usageRate}%`}
          sub={`${data.guestPasses.used}/${data.guestPasses.created} used (30d)`}
        />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Today's breakdown */}
        <div className="card p-5">
          <h2 className="font-semibold text-primary mb-4">Today&apos;s Breakdown</h2>
          <EntryBreakdown resident={data.today.resident} guest={data.today.guest} />
        </div>

        <div className="card p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-primary">Access Activity</h2>
              <p className="mt-1 text-xs text-primary/45">Entry scans over the last 7 days</p>
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
          <WeekChart byDay={data.byDay} />
          <ActivityPanel
            week={data.week.total}
            month={data.month.total}
            created={data.guestPasses.created}
            used={data.guestPasses.used}
          />
        </div>
      </div>

      {/* Recent Entry Logs */}
      <div className="card overflow-hidden">
        <AdminCardHeader
          title="Recent Entries"
          subtitle="Latest verified resident and guest scans"
          action={(
            <a href="/admin/entry-logs" className="admin-action-link">
              <AdminIcon name="chevron-right" />
              <span>View all</span>
            </a>
          )}
        />
        <div className="overflow-x-auto">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Unit</th>
                <th>Type</th>
                <th>Time</th>
                <th>Scanner</th>
              </tr>
            </thead>
            <tbody>
              {data.recentLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-state-cell">
                    No entries yet
                  </td>
                </tr>
              ) : (
                data.recentLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="font-medium text-primary">{log.tenant_name}</td>
                    <td className="text-primary/70">
                      {formatUnitForColumn(log.unit_address)}
                    </td>
                    <td>
                      <span
                        className={`status-pill capitalize ${
                          log.entry_type === "resident" ? "pill-info" : "pill-accent"
                        }`}
                      >
                        <span className="pill-dot" />
                        {log.entry_type}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-primary/50 tabular-nums">
                      {format(new Date(log.entered_at), "MMM d, h:mm a")}
                    </td>
                    <td className="font-mono text-xs text-primary/40">
                      {log.scanner_id ? (scannerNames[log.scanner_id] ?? log.scanner_id) : "—"}
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

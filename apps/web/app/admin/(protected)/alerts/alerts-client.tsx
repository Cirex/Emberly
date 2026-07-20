"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import type { AdminAlert, AlertStatusFilter } from "@/lib/admin-alerts";
import { AdminButton, AdminField, AdminIcon, AdminSelect } from "../../_components/admin-ui";
import { fetchAdminJson } from "../_components/admin-fetch";
import { useAdminList } from "../_components/use-admin-list";

type AlertsResponse = {
  alerts?: AdminAlert[];
};

function subjectHref(alert: AdminAlert) {
  if (alert.subject_type === "resident") return `/admin/residents/${alert.subject_id}`;
  if (alert.subject_type === "scanner") return "/admin/scanners";
  if (alert.subject_type === "guest_pass") return "/admin/guest-passes";
  return null;
}

function severityTint(severity: AdminAlert["severity"]): string {
  if (severity === "critical") return "pill-crit";
  if (severity === "warning") return "pill-warn";
  return "pill-neutral";
}

function severityLabel(severity: AdminAlert["severity"]): string {
  if (severity === "critical") return "Critical";
  if (severity === "warning") return "Warning";
  return "Info";
}

function severityColor(severity: AdminAlert["severity"]): string {
  if (severity === "critical") return "var(--color-crit)";
  if (severity === "warning") return "var(--color-warn)";
  return "var(--color-muted)";
}

function AlertTriangle() {
  return (
    <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function Dot() {
  return <span className="h-[3px] w-[3px] shrink-0 rounded-full bg-primary/30" />;
}

export function AlertsClient({
  initialAlerts,
  initialError,
}: {
  initialAlerts: AdminAlert[];
  initialError: string;
}) {
  const [status, setStatus] = useState<AlertStatusFilter>("open");

  const load = useCallback(async () => {
    const data = await fetchAdminJson<AlertsResponse>(`/api/admin/alerts?status=${status}`);
    return { items: data.alerts ?? [] };
  }, [status]);

  const {
    items: alerts,
    loading,
    error,
    setError,
    refresh: fetchAlerts,
  } = useAdminList<AdminAlert>({
    initialItems: initialAlerts,
    initialError,
    loadErrorMessage: "Failed to load alerts",
    load,
  });

  async function resolveAlert(id: string) {
    setError("");
    try {
      await fetchAdminJson(`/api/admin/alerts/${id}/resolve`, { method: "POST" });
      await fetchAlerts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve alert");
    }
  }

  const openAlerts = alerts.filter((a) => a.status === "open");
  const resolvedAlerts = alerts.filter((a) => a.status === "resolved");

  function AlertRow({ alert }: { alert: AdminAlert }) {
    const href = subjectHref(alert);
    const isOpen = alert.status === "open";
    return (
      <div className="flex gap-3.5 px-4 py-3.5 transition-colors hover:bg-primary/[0.03]">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${severityTint(alert.severity)}`}
        >
          <AlertTriangle />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-sm leading-snug text-primary/90">{alert.detail || alert.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-primary/45">
            <span className="font-semibold" style={{ color: severityColor(alert.severity) }}>
              {severityLabel(alert.severity)}
            </span>
            <Dot />
            <span className="tabular-nums">{format(new Date(alert.created_at), "MMM d, h:mm a")}</span>
            {href ? (
              <>
                <Dot />
                <Link
                  href={href}
                  className="font-medium text-primary/60 underline-offset-2 hover:text-primary hover:underline"
                >
                  View {alert.subject_type.replace("_", " ")}
                </Link>
              </>
            ) : null}
            {!isOpen && alert.resolved_at ? (
              <>
                <Dot />
                <span>resolved {format(new Date(alert.resolved_at), "MMM d")}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 self-center">
          {isOpen ? (
            <AdminButton
              variant="ghost"
              icon="check"
              type="button"
              className="h-8 px-3 text-xs"
              onClick={() => resolveAlert(alert.id)}
            >
              Resolve
            </AdminButton>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-primary/40">
              <span style={{ color: "var(--color-ok)" }}>
                <AdminIcon name="check" className="h-3.5 w-3.5" />
              </span>
              Resolved
            </span>
          )}
        </div>
      </div>
    );
  }

  function GroupHeader({ label }: { label: string }) {
    return (
      <p className="border-b border-primary/[0.06] px-4 pb-2 pt-4 text-[11px] font-bold uppercase tracking-[0.06em] text-primary/40">
        {label}
      </p>
    );
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Exceptions</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Alerts</h1>
          <p className="mt-1 text-sm text-primary/55">
            Things that need a look — lapsed access, quiet scanners, and denied scans.
          </p>
        </div>
        <AdminField label="Status" className="w-full sm:w-auto">
          <AdminSelect
            className="w-full sm:w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value as AlertStatusFilter)}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </AdminSelect>
        </AdminField>
      </div>

      <div className="card overflow-hidden">
        {error ? (
          <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="empty-state-cell">Refreshing alerts...</div>
        ) : alerts.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full pill-ok">
              <AdminIcon name="check" className="h-6 w-6" />
            </span>
            <p className="text-sm font-semibold text-primary/70">No alerts</p>
            <p className="mt-1 text-xs text-primary/45">All clear — nothing needs attention right now.</p>
          </div>
        ) : (
          <div className="divide-y divide-primary/[0.04]">
            {openAlerts.length > 0 ? (
              <div>
                <GroupHeader label={`Needs attention · ${openAlerts.length} open`} />
                {openAlerts.map((alert) => (
                  <AlertRow key={alert.id} alert={alert} />
                ))}
              </div>
            ) : null}
            {resolvedAlerts.length > 0 ? (
              <div>
                <GroupHeader label="Resolved" />
                {resolvedAlerts.map((alert) => (
                  <AlertRow key={alert.id} alert={alert} />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

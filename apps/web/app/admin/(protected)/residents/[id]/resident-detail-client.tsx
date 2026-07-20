"use client";

import { useCallback, useState } from "react";
import { format } from "date-fns";
import { formatUnitForColumn } from "@/lib/admin-data";
import type { AdminResidentDetail } from "@/lib/admin-resident-detail";
import { AdminButton, AdminCardHeader, AdminLinkButton } from "../../../_components/admin-ui";
import { fetchAdminJson } from "../../_components/admin-fetch";
import { healthPillClass } from "../../_components/pills";

export function ResidentDetailClient({
  residentId,
  initialDetail,
  initialError = "",
  scannerNames = {},
}: {
  residentId: string;
  initialDetail: AdminResidentDetail | null;
  initialError?: string;
  scannerNames?: Record<string, string>;
}) {
  const [detail, setDetail] = useState<AdminResidentDetail | null>(initialDetail);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState(initialError);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchAdminJson<AdminResidentDetail>(`/api/admin/residents/${residentId}`);
      setDetail(data);
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load resident.";
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [residentId]);

  async function runAction(action: "require_reauth" | "suspend_access") {
    setActionLoading(action);
    setError("");
    try {
      await fetchAdminJson(`/api/admin/residents/${residentId}/session-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update resident.");
    } finally {
      setActionLoading(null);
    }
  }

  if (!detail) {
    return (
      <div className="admin-page">
        <div className="admin-page-header">
          <div>
            <p className="admin-kicker">Resident Detail</p>
            <h1 className="mt-1 text-2xl font-bold text-primary">Resident unavailable</h1>
            <p className="mt-1 text-sm text-primary/55">{error || "Resident not found."}</p>
          </div>
          <AdminLinkButton href="/admin/residents" icon="arrow-left">
            Back to Residents
          </AdminLinkButton>
        </div>
        <div className="card p-6">
          <p className="text-sm text-primary/60">{error || "Resident not found."}</p>
          <AdminButton className="mt-4" icon="refresh" onClick={fetchDetail} disabled={loading}>
            {loading ? "Retrying..." : "Retry"}
          </AdminButton>
        </div>
      </div>
    );
  }

  const { resident } = detail;

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Resident Detail</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">{resident.name}</h1>
          <p className="mt-1 text-sm text-primary/55">
            {formatUnitForColumn(resident.unit_id)}
          </p>
        </div>
        <AdminLinkButton href="/admin/residents" icon="arrow-left">
          Back to Residents
        </AdminLinkButton>
      </div>

      {error ? (
        <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="admin-kicker">Access Health</p>
              <h2 className="mt-1 text-lg font-semibold text-primary">{resident.accessHealth.label}</h2>
              <p className="mt-1 text-sm text-primary/55">{resident.accessHealth.detail}</p>
            </div>
            <span className={`health-pill ${healthPillClass(resident.accessHealth.severity)}`}>
              {resident.accessHealth.status.replace("_", " ")}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-primary/10 bg-primary/[0.03] p-4">
              <p className="admin-kicker">Guest Passes</p>
              <p className="mt-2 text-2xl font-bold tabular-nums text-primary">{detail.totals.guestPasses}</p>
              <p className="mt-1 text-xs text-primary/45">{detail.totals.activeGuestPasses} active</p>
            </div>
            <div className="rounded-lg border border-primary/10 bg-primary/[0.03] p-4">
              <p className="admin-kicker">Entries</p>
              <p className="mt-2 text-2xl font-bold tabular-nums text-primary">{detail.totals.entries}</p>
              <p className="mt-1 text-xs text-primary/45">recent scans</p>
            </div>
            <div className="rounded-lg border border-primary/10 bg-primary/[0.03] p-4">
              <p className="admin-kicker">ResMan Status</p>
              <p className="mt-2 text-sm font-semibold text-primary">{resident.access_status ?? "Unknown"}</p>
              <p className="mt-1 text-xs text-primary/45">
                {resident.last_resman_verified_at
                  ? format(new Date(resident.last_resman_verified_at), "MMM d, h:mm a")
                  : "Never verified"}
              </p>
            </div>
          </div>
        </div>

        <div className="card p-5">
          <p className="admin-kicker">Actions</p>
          <div className="mt-4 space-y-2">
            <AdminButton
              className="w-full"
              icon="refresh"
              disabled={!!actionLoading || loading}
              onClick={() => runAction("require_reauth")}
            >
              {actionLoading === "require_reauth" ? "Updating..." : "Require Reauthentication"}
            </AdminButton>
            <AdminButton
              variant="danger"
              className="w-full"
              icon="ban"
              disabled={!!actionLoading || loading}
              onClick={() => runAction("suspend_access")}
            >
              {actionLoading === "suspend_access" ? "Suspending..." : "Suspend all access"}
            </AdminButton>
          </div>
          <p className="mt-3 text-[11.5px] leading-snug text-primary/45">
            Suspending all access revokes the resident&rsquo;s own entry. To stop only new guest passes,
            use <span className="font-semibold text-primary/60">Block guest passes</span> on the residents list.
          </p>
          {resident.ban && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              Guest passes blocked: {resident.ban.reason ?? "No reason provided"}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <AdminCardHeader title="Recent Guest Passes" subtitle="Newest passes for this resident" />
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Status</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {detail.guestPasses.length === 0 ? (
                  <tr><td colSpan={3} className="empty-state-cell">No guest passes yet</td></tr>
                ) : detail.guestPasses.map((pass) => (
                  <tr key={pass.id}>
                    <td>
                      <p className="font-medium text-primary">{pass.guest_name}</p>
                      <p className="text-xs text-primary/45">{pass.guest_email}</p>
                    </td>
                    <td><span className="status-pill border-primary/15 bg-primary/5 text-primary">{pass.status}</span></td>
                    <td className="whitespace-nowrap text-primary/55 tabular-nums">{format(new Date(pass.expires_at), "MMM d, h:mm a")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card overflow-hidden">
          <AdminCardHeader title="Audit Timeline" subtitle="Recent resident and guest scans" />
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Time</th>
                  <th>Scanner</th>
                </tr>
              </thead>
              <tbody>
                {detail.entryLogs.length === 0 ? (
                  <tr><td colSpan={4} className="empty-state-cell">No entry scans yet</td></tr>
                ) : detail.entryLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="font-medium text-primary">{log.tenant_name}</td>
                    <td><span className="status-pill border-primary/15 bg-primary/5 text-primary">{log.entry_type}</span></td>
                    <td className="whitespace-nowrap text-primary/55 tabular-nums">{format(new Date(log.entered_at), "MMM d, h:mm a")}</td>
                    <td className="text-xs text-primary/55">{log.scanner_id ? (scannerNames[log.scanner_id] ?? log.scanner_id) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

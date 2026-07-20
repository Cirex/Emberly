"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { format } from "date-fns";
import { AdminButton, AdminCardHeader } from "../../_components/admin-ui";
import { fetchAdminJson } from "../_components/admin-fetch";

export type MapSyncAccessRequestRow = {
  id: string;
  property_name: string;
  property_id: string;
  feature_key: string;
  requester_display_name: string | null;
  device_id: string;
  status: string;
  rejection_reason: string | null;
  created_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
};

export type MapSyncKeyRow = {
  id: string;
  property_name: string;
  property_id: string;
  feature_key: string;
  requester_display_name: string | null;
  device_id: string;
  last_used_at: string | null;
  created_at: string | null;
};

export type MapSyncAuditLogRow = {
  id: string;
  property_id: string;
  feature_key: string;
  action: string;
  annotation_id: string | null;
  actor_display_name: string | null;
  admin_display_name: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

type MapSyncClientProps = {
  initialRequests: MapSyncAccessRequestRow[];
  initialKeys: MapSyncKeyRow[];
  initialAudits: MapSyncAuditLogRow[];
  initialError: string;
};

function formatDate(value: string | null): string {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  return format(date, "MMM d, yyyy h:mm a");
}

function formatFeature(value: string): string {
  return value.replace("property_map.", "Property Map ");
}

function actorLabel(row: MapSyncAuditLogRow): string {
  return row.admin_display_name || row.actor_display_name || "System";
}

export function MapSyncClient({
  initialRequests,
  initialKeys,
  initialAudits,
  initialError,
}: MapSyncClientProps) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [error, setError] = useState(initialError);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});

  async function submitMapSyncAction(actionId: string, url: string, body?: Record<string, unknown>) {
    setError("");
    setPendingAction(actionId);

    try {
      await fetchAdminJson<Record<string, unknown>>(url, {
        method: "POST",
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Map data action failed");
    } finally {
      setPendingAction(null);
    }
  }

  function approveRequest(request: MapSyncAccessRequestRow) {
    return submitMapSyncAction(
      `approve-${request.id}`,
      `/api/map/admin/access-requests/${request.id}/approve`
    );
  }

  function rejectRequest(request: MapSyncAccessRequestRow) {
    return submitMapSyncAction(
      `reject-${request.id}`,
      `/api/map/admin/access-requests/${request.id}/reject`,
      { rejectionReason: rejectionReasons[request.id]?.trim() || null }
    );
  }

  function revokeKey(key: MapSyncKeyRow) {
    return submitMapSyncAction(
      `revoke-${key.id}`,
      `/api/map/admin/sync-keys/${key.id}/revoke`
    );
  }

  const statusText = pendingAction
    ? "Submitting map data action..."
    : isRefreshing
      ? "Refreshing map data..."
      : "";
  const actionsDisabled = pendingAction !== null || isRefreshing;

  return (
    <>
      {error ? (
        <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      ) : null}

      <div className="space-y-6">
        <section className="card overflow-hidden">
          <AdminCardHeader
            title="Pending Access Requests"
            subtitle="Newest pending and approved property map annotation requests"
          />
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Feature</th>
                  <th>Requester</th>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {initialRequests.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-state-cell">
                      No pending access requests
                    </td>
                  </tr>
                ) : (
                  initialRequests.map((request) => (
                    <tr key={request.id}>
                      <td>
                        <p className="font-medium text-primary">{request.property_name}</p>
                        <p className="mt-1 font-mono text-xs text-primary/40">{request.property_id}</p>
                      </td>
                      <td className="text-primary/70">{formatFeature(request.feature_key)}</td>
                      <td className="text-primary/70">{request.requester_display_name || "Unknown requester"}</td>
                      <td className="font-mono text-xs text-primary/50">{request.device_id}</td>
                      <td>
                        <span className="status-pill border-transparent bg-primary/10 text-primary">
                          {request.status}
                        </span>
                        {request.status === "approved" && request.approved_at ? (
                          <p className="mt-1 text-xs text-primary/45">
                            Approved {formatDate(request.approved_at)}
                          </p>
                        ) : null}
                      </td>
                      <td>
                        {request.status === "pending" ? (
                          <div className="flex min-w-64 flex-wrap items-center gap-2">
                            <AdminButton
                              type="button"
                              icon="check"
                              className="text-xs"
                              disabled={actionsDisabled}
                              onClick={() => approveRequest(request)}
                            >
                              Approve
                            </AdminButton>
                            <input
                              type="text"
                              value={rejectionReasons[request.id] ?? ""}
                              onChange={(event) =>
                                setRejectionReasons((current) => ({
                                  ...current,
                                  [request.id]: event.target.value,
                                }))
                              }
                              placeholder="Reason (optional)"
                              aria-label={`Rejection reason for ${request.property_name}`}
                              className="min-h-9 w-36 rounded-lg border border-primary/10 bg-white px-3 py-1.5 text-xs text-primary outline-hidden transition-colors placeholder:text-primary/35 focus:border-accent"
                            />
                            <AdminButton
                              type="button"
                              variant="danger"
                              icon="x"
                              className="text-xs"
                              disabled={actionsDisabled}
                              onClick={() => rejectRequest(request)}
                            >
                              Reject
                            </AdminButton>
                          </div>
                        ) : (
                          <span className="text-xs text-primary/40">Awaiting claim</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card overflow-hidden">
          <AdminCardHeader
            title="Active Map Data Keys"
            subtitle="Devices currently allowed to sync property map annotations"
          />
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Feature</th>
                  <th>Requester</th>
                  <th>Device / Last Used</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {initialKeys.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-state-cell">
                      No active map data keys
                    </td>
                  </tr>
                ) : (
                  initialKeys.map((key) => (
                    <tr key={key.id}>
                      <td>
                        <p className="font-medium text-primary">{key.property_name}</p>
                        <p className="mt-1 font-mono text-xs text-primary/40">{key.property_id}</p>
                      </td>
                      <td className="text-primary/70">{formatFeature(key.feature_key)}</td>
                      <td className="text-primary/70">{key.requester_display_name || "Unknown requester"}</td>
                      <td>
                        <p className="font-mono text-xs text-primary/55">{key.device_id}</p>
                        <p className="mt-1 text-xs text-primary/45">
                          Last used {formatDate(key.last_used_at)}
                        </p>
                      </td>
                      <td>
                        <AdminButton
                          type="button"
                          variant="danger"
                          icon="ban"
                          className="text-xs"
                          disabled={actionsDisabled}
                          onClick={() => revokeKey(key)}
                        >
                          Revoke
                        </AdminButton>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

      </div>

      <p className="mt-4 text-sm font-medium text-primary/55" aria-live="polite">
        {statusText}
      </p>
    </>
  );
}

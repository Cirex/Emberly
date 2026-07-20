"use client";

import { useCallback, useState } from "react";
import { format } from "date-fns";
import { formatUnitForColumn } from "@/lib/admin-data";
import type { AdminPagination, GuestPassRow, PassStatus } from "@/lib/admin-guest-passes";
import { AdminButton, AdminField, AdminSelect } from "../../_components/admin-ui";
import { fetchAdminJson } from "../_components/admin-fetch";
import { PaginationFooter } from "../_components/pagination-footer";
import { useAdminList } from "../_components/use-admin-list";

type GuestPassesResponse = {
  passes?: GuestPassRow[];
  pagination?: AdminPagination;
};

type UpdateGuestPassResponse = {
  pass: Partial<GuestPassRow> & { id: string };
};

function statusStyles(status: PassStatus): string {
  if (status === "active") return "pill-ok";
  if (status === "used") return "pill-info";
  if (status === "expired") return "pill-neutral";
  return "pill-crit";
}

export function GuestPassesClient({
  initialPasses,
  initialPagination,
  initialError,
}: {
  initialPasses: GuestPassRow[];
  initialPagination: AdminPagination | null;
  initialError: string;
}) {
  const [status, setStatus] = useState<"" | PassStatus>("");
  const [search, setSearch] = useState("");

  const load = useCallback(async (page: number) => {
    const params = new URLSearchParams({
      page: String(page),
      limit: "50",
    });
    if (status) params.set("status", status);
    if (search) params.set("search", search);

    const data = await fetchAdminJson<GuestPassesResponse>(`/api/admin/guest-passes?${params}`);
    return { items: data.passes ?? [], pagination: data.pagination ?? null };
  }, [search, status]);

  const {
    items: passes,
    setItems: setPasses,
    pagination,
    setPage,
    loading,
    error,
    setError,
    refresh: fetchPasses,
  } = useAdminList<GuestPassRow>({
    initialItems: initialPasses,
    initialPagination,
    initialError,
    loadErrorMessage: "Failed to load guest passes",
    load,
  });

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchPasses();
  }

  async function updatePass(passId: string, body: { expiresAt?: string; status?: "revoked" }) {
    setError("");
    try {
      const data = await fetchAdminJson<UpdateGuestPassResponse>(`/api/admin/guest-passes/${passId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setPasses((current) => current.map((pass) => (
        pass.id === passId ? { ...pass, ...data.pass } : pass
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update guest pass");
    }
  }

  function revokePass(pass: GuestPassRow) {
    const confirmed = window.confirm(
      `Revoke ${pass.guest_name}'s guest pass? It will stop working immediately.`
    );
    if (!confirmed) return;

    void updatePass(pass.id, { status: "revoked" });
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Access</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Guest Passes</h1>
          <p className="text-primary/55 text-sm mt-1">
            {pagination ? `${pagination.total.toLocaleString()} passes found` : "No pass total available"}
          </p>
        </div>
      </div>

      <form onSubmit={handleFilterSubmit} className="admin-filter-bar">
        <AdminField label="Status">
          <AdminSelect
            value={status}
            onChange={(e) => setStatus(e.target.value as "" | PassStatus)}
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="used">Used</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </AdminSelect>
        </AdminField>
        <AdminField label="Search" className="w-full sm:w-72">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Guest name or email..."
            className="admin-input w-full"
          />
        </AdminField>
        <AdminButton type="submit" icon="filter">
          Apply Filters
        </AdminButton>
        <AdminButton
          type="button"
          variant="ghost"
          icon="refresh"
          onClick={() => {
            setStatus("");
            setSearch("");
            setPage(1);
          }}
        >
          Reset
        </AdminButton>
      </form>

      <div className="card overflow-hidden">
        {error ? (
          <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Guest</th>
                <th>Unit</th>
                <th>Status</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="empty-state-cell">
                    Refreshing guest passes...
                  </td>
                </tr>
              ) : passes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-state-cell">
                    No guest passes found
                  </td>
                </tr>
              ) : (
                passes.map((pass) => {
                  const resident = Array.isArray(pass.residents) ? pass.residents[0] : pass.residents;
                  return (
                    <tr key={pass.id}>
                      <td>
                        <p className="font-medium text-primary">{pass.guest_name}</p>
                        <p className="text-primary/45 text-xs">{pass.guest_email}</p>
                      </td>
                      <td className="text-primary/75">
                        {formatUnitForColumn(resident?.unit_id)}
                      </td>
                      <td>
                        <span className={`status-pill ${statusStyles(pass.status)}`}>
                          {pass.status}
                        </span>
                      </td>
                      <td className="text-primary/55 tabular-nums whitespace-nowrap">
                        {format(new Date(pass.created_at), "MMM d, h:mm a")}
                      </td>
                      <td className="text-primary/55 tabular-nums whitespace-nowrap">
                        {format(new Date(pass.expires_at), "MMM d, h:mm a")}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {pass.status === "active" && (
                            <>
                              <AdminButton
                                type="button"
                                variant="link"
                                icon="plus"
                                onClick={() => updatePass(pass.id, {
                                  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                                })}
                              >
                                Extend 24h
                              </AdminButton>
                              <AdminButton
                                type="button"
                                variant="danger-link"
                                icon="ban"
                                onClick={() => revokePass(pass)}
                              >
                                Revoke
                              </AdminButton>
                            </>
                          )}
                          {pass.status !== "active" && (
                            <span className="text-primary/35 text-sm">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <PaginationFooter pagination={pagination} noun="passes" onPageChange={setPage} />
      </div>
    </div>
  );
}

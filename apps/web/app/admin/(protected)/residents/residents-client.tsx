"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { formatUnitForColumn } from "@/lib/admin-data";
import type { AdminResident } from "@/lib/admin-residents";
import { AdminButton, AdminIcon } from "../../_components/admin-ui";
import { fetchAdminJson } from "../_components/admin-fetch";
import { healthPillClass } from "../_components/pills";
import { useAdminList } from "../_components/use-admin-list";

type Resident = AdminResident;
type ResidentsResponse = { residents?: Resident[]; total?: number };

function BanModal({
  resident,
  onClose,
  onBanned,
}: {
  resident: Resident;
  onClose: () => void;
  onBanned: () => void;
}) {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleBan() {
    setLoading(true);
    setError("");
    try {
      await fetchAdminJson(`/api/admin/residents/${resident.id}/ban-guest-pass`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason }),
      });

      onBanned();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-primary/45 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-line bg-white p-6 shadow-2xl shadow-primary/20">
        <h3 className="font-bold text-primary text-lg mb-1">Block guest passes</h3>
        <p className="text-primary/60 text-sm mb-4">
          <strong>{resident.name}</strong> — {formatUnitForColumn(resident.unit_id)}
        </p>
        <div className="mb-4 flex gap-3 rounded-lg border border-accent/30 bg-accent/10 p-3">
          <span className="mt-0.5 shrink-0" style={{ color: "var(--color-accent-deep)" }}>
            <AdminIcon name="shield" className="h-4 w-4" />
          </span>
          <div className="text-xs text-primary/70">
            <p className="font-semibold text-primary">This resident keeps their own access.</p>
            <p className="mt-0.5">They just won&rsquo;t be able to create new guest passes. Existing passes stay valid until they expire.</p>
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-primary mb-1">
            Reason <span className="text-primary/40">(optional)</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why are guest passes being blocked for this resident?"
            className="admin-textarea w-full resize-none"
          />
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex gap-2 justify-end">
          <AdminButton type="button" variant="ghost" icon="x" onClick={onClose}>
            Cancel
          </AdminButton>
          <AdminButton
            type="button"
            variant="danger"
            icon="ban"
            onClick={handleBan}
            disabled={loading}
          >
            {loading ? "Blocking..." : "Block guest passes"}
          </AdminButton>
        </div>
      </div>
    </div>
  );
}

export function ResidentsClient({
  initialResidents,
  initialError = "",
}: {
  initialResidents: Resident[];
  initialError?: string;
}) {
  const [search, setSearch] = useState("");
  const [banModal, setBanModal] = useState<Resident | null>(null);
  const [unbanLoading, setUnbanLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await fetchAdminJson<ResidentsResponse>("/api/admin/residents");
    return { items: data.residents ?? [] };
  }, []);

  const {
    items: residents,
    loading,
    error,
    setError,
    refresh: fetchResidents,
  } = useAdminList<Resident>({
    initialItems: initialResidents,
    initialError,
    loadErrorMessage: "Failed to load residents",
    load,
  });

  async function handleUnban(residentId: string) {
    setUnbanLoading(residentId);
    setError("");
    try {
      await fetchAdminJson(`/api/admin/residents/${residentId}/ban-guest-pass`, {
        method: "DELETE",
      });
      await fetchResidents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove suspension");
    } finally {
      setUnbanLoading(null);
    }
  }

  const filtered = residents.filter(
    (r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.unit_id.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Directory</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Resident Access</h1>
          <p className="text-primary/50 text-sm mt-1">{residents.length} residents total</p>
        </div>
        <input
          type="search"
          placeholder="Search by name or unit..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="admin-input w-full sm:w-72"
        />
      </div>

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
                <th>Resident</th>
                <th>Unit</th>
                <th>Access</th>
                <th>Joined</th>
                <th>Guest Passes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="empty-state-cell">
                    Loading residents...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-state-cell">
                    {search ? "No residents match your search" : "No residents found"}
                  </td>
                </tr>
              ) : (
                filtered.map((resident) => (
                  <tr key={resident.id}>
                    <td>
                      <Link
                        href={`/admin/residents/${resident.id}`}
                        className="font-medium text-primary underline-offset-2 hover:text-primaryLight hover:underline"
                      >
                        {resident.name}
                      </Link>
                    </td>
                    <td className="text-primary/70">
                      {formatUnitForColumn(resident.unit_id)}
                    </td>
                    <td>
                      <span className={`health-pill ${healthPillClass(resident.accessHealth?.severity)}`}>
                        {resident.accessHealth?.label ?? "Unknown"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-primary/50">
                      {format(new Date(resident.created_at), "MMM d, yyyy")}
                    </td>
                    <td>
                      {resident.ban ? (
                        <span className="status-pill pill-crit">
                          <span className="pill-dot" />
                          Blocked
                        </span>
                      ) : (
                        <span className="status-pill pill-ok">
                          <span className="pill-dot" />
                          Can create
                        </span>
                      )}
                    </td>
                    <td>
                      {resident.ban ? (
                        <AdminButton
                          type="button"
                          variant="link"
                          icon="unlock"
                          onClick={() => handleUnban(resident.id)}
                          disabled={unbanLoading === resident.id}
                        >
                          {unbanLoading === resident.id ? "Removing..." : "Allow guest passes"}
                        </AdminButton>
                      ) : (
                        <AdminButton
                          type="button"
                          variant="danger-link"
                          icon="ban"
                          onClick={() => setBanModal(resident)}
                        >
                          Block guest passes
                        </AdminButton>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {banModal && (
        <BanModal
          resident={banModal}
          onClose={() => setBanModal(null)}
          onBanned={fetchResidents}
        />
      )}
    </div>
  );
}

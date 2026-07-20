"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { format, subDays } from "date-fns";
import { formatUnitForColumn } from "@/lib/admin-data";
import type { AdminPagination } from "@/lib/admin-guest-passes";
import type { EntryLog } from "@/lib/admin-entry-logs";
import { AdminButton, AdminField, AdminIcon, AdminSelect } from "../../_components/admin-ui";
import { fetchAdminJson } from "../_components/admin-fetch";
import { PaginationFooter } from "../_components/pagination-footer";
import { useAdminList } from "../_components/use-admin-list";

type EntryLogsResponse = {
  logs?: EntryLog[];
  pagination?: AdminPagination;
};

type EntryLogPhoto = {
  id: string;
  entryLogId: string;
  residentId: string | null;
  guestPassId: string | null;
  entryType: "resident" | "guest";
  scannerId: string | null;
  contentType: string;
  byteSize: number;
  createdAt: string | null;
  url: string | null;
};

type EntryLogPhotosResponse = {
  photos?: EntryLogPhoto[];
};

export function EntryLogsClient({
  initialLogs,
  initialPagination,
  initialError,
  initialFrom,
  initialTo,
  scannerNames = {},
}: {
  initialLogs: EntryLog[];
  initialPagination: AdminPagination | null;
  initialError: string;
  initialFrom: string;
  initialTo: string;
  scannerNames?: Record<string, string>;
}) {
  const scannerLabel = (id: string | null | undefined) => (id ? (scannerNames[id] ?? id) : "—");
  const [selectedPhotoLog, setSelectedPhotoLog] = useState<EntryLog | null>(null);
  const [selectedPhotos, setSelectedPhotos] = useState<EntryLogPhoto[]>([]);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState("");

  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [entryType, setEntryType] = useState<"" | "resident" | "guest">("");
  const [propertyFilter, setPropertyFilter] = useState("");

  const load = useCallback(async (page: number) => {
    const params = new URLSearchParams({
      page: String(page),
      limit: "50",
    });
    if (from) params.set("from", `${from}T00:00:00Z`);
    if (to) params.set("to", `${to}T23:59:59Z`);
    if (entryType) params.set("entryType", entryType);
    if (propertyFilter) params.set("propertyName", propertyFilter);

    const data = await fetchAdminJson<EntryLogsResponse>(`/api/admin/entry-logs?${params}`);
    return { items: data.logs ?? [], pagination: data.pagination ?? null };
  }, [from, to, entryType, propertyFilter]);

  const {
    items: logs,
    pagination,
    setPage,
    loading,
    error,
    refresh: fetchLogs,
  } = useAdminList<EntryLog>({
    initialItems: initialLogs,
    initialPagination,
    initialError,
    loadErrorMessage: "Failed to load entry logs",
    load,
  });

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchLogs();
  }

  async function openPhotoReview(log: EntryLog) {
    setSelectedPhotoLog(log);
    setSelectedPhotos([]);
    setPhotoError("");
    setPhotoLoading(true);
    try {
      const data = await fetchAdminJson<EntryLogPhotosResponse>(`/api/admin/entry-logs/${log.id}/photos`);
      setSelectedPhotos(data.photos ?? []);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Failed to load scan photos");
    } finally {
      setPhotoLoading(false);
    }
  }

  function closePhotoReview() {
    setSelectedPhotoLog(null);
    setSelectedPhotos([]);
    setPhotoError("");
    setPhotoLoading(false);
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Security</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Entry Logs</h1>
        </div>
        <p className="text-primary/50 text-sm mt-1">
          {pagination ? `${pagination.total.toLocaleString()} total entries` : "No entry total available"}
        </p>
      </div>

      <form onSubmit={handleFilterSubmit} className="admin-filter-bar">
        <AdminField label="From">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="admin-input"
          />
        </AdminField>
        <AdminField label="To">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="admin-input"
          />
        </AdminField>
        <AdminField label="Type">
          <AdminSelect
            value={entryType}
            onChange={(e) => setEntryType(e.target.value as "" | "resident" | "guest")}
          >
            <option value="">All</option>
            <option value="resident">Resident</option>
            <option value="guest">Guest</option>
          </AdminSelect>
        </AdminField>
        <AdminField label="Property" className="w-full sm:w-52">
          <input
            type="text"
            value={propertyFilter}
            onChange={(e) => setPropertyFilter(e.target.value)}
            placeholder="Filter by property..."
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
            setFrom(format(subDays(new Date(), 7), "yyyy-MM-dd"));
            setTo(format(new Date(), "yyyy-MM-dd"));
            setEntryType("");
            setPropertyFilter("");
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
                <th>Name</th>
                <th>Unit</th>
                <th>Property</th>
                <th>Type</th>
                <th>Time</th>
                <th>Scanner</th>
                <th>Photos</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="empty-state-cell">
                    Refreshing entries...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-state-cell">
                    No entries found for the selected filters
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id}>
                    <td className="font-medium text-primary">
                      {log.resident_id ? (
                        <Link
                          href={`/admin/residents/${log.resident_id}`}
                          className="underline-offset-2 hover:text-primaryLight hover:underline"
                        >
                          {log.tenant_name}
                        </Link>
                      ) : log.tenant_name}
                    </td>
                    <td className="text-primary/70">
                      {formatUnitForColumn(log.unit_address)}
                    </td>
                    <td className="text-primary/70">{log.property_name}</td>
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
                    <td className="text-primary/50 tabular-nums whitespace-nowrap">
                      {format(new Date(log.entered_at), "MMM d, yyyy h:mm a")}
                    </td>
                    <td className="font-mono text-xs text-primary/40">
                      {scannerLabel(log.scanner_id)}
                    </td>
                    <td>
                      {log.photo_count > 0 ? (
                        <button
                          type="button"
                          onClick={() => openPhotoReview(log)}
                          className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-primary transition hover:bg-accent/20"
                        >
                          <AdminIcon name="eye" />
                          <span>View Photos</span>
                          <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] text-primary/60">
                            {log.photo_count}
                          </span>
                        </button>
                      ) : (
                        <span className="text-sm text-primary/35">-</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <PaginationFooter
          pagination={pagination}
          noun="entries"
          onPageChange={setPage}
          summaryClassName="text-sm text-primary/50"
        />
      </div>

      {selectedPhotoLog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-primary/35 p-4 backdrop-blur-sm">
          <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-white/60 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-primary/10 px-6 py-5">
              <div>
                <p className="admin-kicker">Scan Photos</p>
                <h2 className="mt-1 text-xl font-bold text-primary">{selectedPhotoLog.tenant_name}</h2>
                <p className="mt-1 text-sm text-primary/55">
                  {formatUnitForColumn(selectedPhotoLog.unit_address)} ·{" "}
                  {format(new Date(selectedPhotoLog.entered_at), "MMM d, yyyy h:mm a")}
                </p>
              </div>
              <button
                type="button"
                onClick={closePhotoReview}
                className="rounded-full border border-primary/10 p-2 text-primary/50 transition hover:bg-primary/5 hover:text-primary"
                aria-label="Close scan photos"
              >
                <AdminIcon name="x" />
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-6">
              {photoLoading ? (
                <div className="empty-state-cell">Loading scan photos...</div>
              ) : photoError ? (
                <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                  {photoError}
                </div>
              ) : selectedPhotos.length === 0 ? (
                <div className="empty-state-cell">No scan photos found for this entry</div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {selectedPhotos.map((photo) => (
                    <figure key={photo.id} className="overflow-hidden rounded-xl border border-primary/10 bg-primary/5">
                      {photo.url ? (
                        // eslint-disable-next-line @next/next/no-img-element -- signed storage URLs are short-lived and not known to next/image.
                        <img
                          src={photo.url}
                          alt={`Scan evidence captured ${photo.createdAt ? format(new Date(photo.createdAt), "MMM d, yyyy h:mm a") : ""}`}
                          className="aspect-video w-full bg-primary/10 object-cover"
                        />
                      ) : (
                        <div className="flex aspect-video items-center justify-center bg-primary/10 text-sm font-semibold text-primary/45">
                          Signed URL unavailable
                        </div>
                      )}
                      <figcaption className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-primary/55">
                        <span>{photo.scannerId ? (scannerNames[photo.scannerId] ?? photo.scannerId) : "Unknown scanner"}</span>
                        <span>{photo.createdAt ? format(new Date(photo.createdAt), "MMM d, h:mm a") : "Unknown time"}</span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

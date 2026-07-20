"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import type { AdminScanner } from "@/lib/admin-scanners";
import { AdminButton, AdminField, AdminIcon } from "../../_components/admin-ui";
import { fetchAdminJson } from "../_components/admin-fetch";
import { healthPillClass } from "../_components/pills";
import { useAdminList } from "../_components/use-admin-list";
import { OneTimeSecretPanel, useOneTimeSecret } from "./_components/scanner-key";

type ScannersResponse = {
  scanners?: AdminScanner[];
  scanner?: AdminScanner;
  scannerSecret?: string;
};

export function ScannersClient({
  initialScanners,
  initialError,
  scanCounts = {},
}: {
  initialScanners: AdminScanner[];
  initialError: string;
  scanCounts?: Record<string, number>;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const { oneTimeSecret, setOneTimeSecret } = useOneTimeSecret();

  const load = useCallback(async () => {
    const data = await fetchAdminJson<ScannersResponse>("/api/admin/scanners");
    return { items: data.scanners ?? [] };
  }, []);

  const {
    items: scanners,
    loading,
    error,
    setError,
    refresh: fetchScanners,
  } = useAdminList<AdminScanner>({
    initialItems: initialScanners,
    initialError,
    loadErrorMessage: "Failed to load scanners",
    load,
  });

  async function createScanner(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const data = await fetchAdminJson<ScannersResponse>("/api/admin/scanners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, location }),
      });
      if (data.scannerSecret && data.scanner) {
        setOneTimeSecret({ scannerId: data.scanner.scanner_id, secret: data.scannerSecret });
      }
      setName("");
      setLocation("");
      await fetchScanners();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save scanner");
    }
  }

  async function toggleScanner(scanner: AdminScanner) {
    setError("");
    try {
      await fetchAdminJson(`/api/admin/scanners/${scanner.scanner_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !scanner.enabled }),
      });
      await fetchScanners();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update scanner");
    }
  }

  async function rotateScannerSecret(scanner: AdminScanner) {
    setError("");
    try {
      const data = await fetchAdminJson<ScannersResponse>(`/api/admin/scanners/${scanner.scanner_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotateSecret: true }),
      });
      if (data.scannerSecret) {
        setOneTimeSecret({ scannerId: scanner.scanner_id, secret: data.scannerSecret });
      }
      await fetchScanners();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate scanner secret");
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Security Devices</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Scanner Devices</h1>
          <p className="mt-1 text-sm text-primary/55">Register, monitor, and disable entry scanners.</p>
        </div>
      </div>

      <form onSubmit={createScanner} className="admin-filter-bar">
        <AdminField label="Name">
          <input className="admin-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Front Gate" required />
        </AdminField>
        <AdminField label="Location" className="w-full sm:w-72">
          <input className="admin-input w-full" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Leasing office entrance" />
        </AdminField>
        <AdminButton icon="save" type="submit">Save Scanner</AdminButton>
      </form>

      {oneTimeSecret ? (
        <OneTimeSecretPanel
          secret={oneTimeSecret.secret}
          scannerLabel={
            scanners.find((s) => s.scanner_id === oneTimeSecret.scannerId)?.name ?? oneTimeSecret.scannerId
          }
          onDone={() => setOneTimeSecret(null)}
        />
      ) : null}

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
                <th>Scanner</th>
                <th>Location</th>
                <th>Health</th>
                <th className="text-right">Scans today</th>
                <th>Last Seen</th>
                <th>State</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="empty-state-cell">Refreshing scanners...</td></tr>
              ) : scanners.length === 0 ? (
                <tr><td colSpan={7} className="empty-state-cell">No scanners registered yet</td></tr>
              ) : scanners.map((scanner) => (
                <tr key={scanner.id}>
                  <td>
                    <Link
                      href={`/admin/scanners/${scanner.scanner_id}`}
                      className="font-medium text-primary underline-offset-2 hover:text-primaryLight hover:underline"
                    >
                      {scanner.name}
                    </Link>
                    <p className="font-mono text-xs text-primary/40">{scanner.scanner_id}</p>
                  </td>
                  <td className="text-primary/65">{scanner.location ?? "-"}</td>
                  <td>
                    <span className={`health-pill ${healthPillClass(scanner.health.severity)}`}>
                      {scanner.health.label}
                    </span>
                    <p className="mt-1 text-xs text-primary/45">{scanner.health.detail}</p>
                  </td>
                  <td className="text-right font-semibold tabular-nums text-primary">
                    {scanCounts[scanner.scanner_id] ?? 0}
                  </td>
                  <td className="whitespace-nowrap text-primary/55 tabular-nums">
                    {scanner.last_seen_at ? format(new Date(scanner.last_seen_at), "MMM d, h:mm a") : "Never"}
                  </td>
                  <td>
                    <span className={`status-pill ${scanner.enabled ? "pill-ok" : "pill-neutral"}`}>
                      <span className="pill-dot" />
                      {scanner.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center justify-end gap-1">
                      <Link href={`/admin/scanners/${scanner.scanner_id}`} className="admin-action-link">
                        <AdminIcon name="activity" />
                        <span>Activity</span>
                      </Link>
                      <AdminButton
                        type="button"
                        variant={scanner.enabled ? "danger-link" : "link"}
                        icon={scanner.enabled ? "ban" : "check"}
                        onClick={() => toggleScanner(scanner)}
                      >
                        {scanner.enabled ? "Disable" : "Enable"}
                      </AdminButton>
                      <AdminButton
                        type="button"
                        variant="link"
                        icon="rotate"
                        onClick={() => rotateScannerSecret(scanner)}
                      >
                        Rotate Secret
                      </AdminButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

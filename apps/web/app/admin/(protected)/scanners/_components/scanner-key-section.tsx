"use client";

import { useState } from "react";
import { format } from "date-fns";
import { AdminButton } from "../../../_components/admin-ui";
import { fetchAdminJson } from "../../_components/admin-fetch";
import { OneTimeSecretPanel, useOneTimeSecret } from "./scanner-key";

/**
 * The access key for one scanner.
 *
 * This deliberately cannot show the current key. `scanner_devices` stores only
 * `secret_hash` — a one-way HMAC — so no existing key can be recovered or
 * displayed here, by design: a key that can be re-read from the admin UI is a
 * key that leaks with the UI. The only honest affordance is minting a new one,
 * which immediately invalidates the old.
 */
export function ScannerKeySection({
  scannerId,
  scannerName,
  rotatedAt,
}: {
  scannerId: string;
  scannerName: string;
  rotatedAt: string | null;
}) {
  const { oneTimeSecret, setOneTimeSecret } = useOneTimeSecret();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // A stashed secret from a different scanner belongs to that scanner's page.
  const secretForThisScanner = oneTimeSecret?.scannerId === scannerId ? oneTimeSecret : null;

  async function generate() {
    setError("");
    setBusy(true);
    try {
      const data = await fetchAdminJson<{ scannerSecret?: string }>(`/api/admin/scanners/${scannerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotateSecret: true }),
      });
      if (data.scannerSecret) setOneTimeSecret({ scannerId, secret: data.scannerSecret });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate a new key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="admin-kicker">Access Key</p>
          <p className="mt-1 text-sm text-primary/55">
            {rotatedAt
              ? `Key last generated ${format(new Date(rotatedAt), "MMM d, yyyy 'at' h:mm a")}.`
              : "No key has been generated for this scanner yet."}
          </p>
          <p className="mt-1 text-xs text-primary/45">
            Existing keys can’t be displayed — only a one-way hash is kept. If the key was lost,
            generate a new one; the device will need to be activated again with it.
          </p>
        </div>
        <AdminButton icon="refresh" onClick={generate} disabled={busy}>
          {busy ? "Generating…" : "Generate new key"}
        </AdminButton>
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {secretForThisScanner ? (
        <div className="mt-3">
          <OneTimeSecretPanel
            secret={secretForThisScanner.secret}
            scannerLabel={scannerName}
            onDone={() => setOneTimeSecret(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

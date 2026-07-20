"use client";

import { useCallback, useEffect, useState } from "react";

export type OneTimeSecret = { scannerId: string; secret: string };

/**
 * A freshly minted key exists in exactly one place — the response that created
 * it. Only its HMAC is stored, so a reload that drops React state destroys the
 * key for good and the scanner has to be rotated again. Parking it in
 * sessionStorage lets it survive an accidental refresh (and, in dev, a Fast
 * Refresh full reload) until it is explicitly dismissed. Session-scoped, so it
 * still dies with the tab.
 */
const SECRET_STASH_KEY = "emberly.admin.scannerOneTimeSecret";

function readStashedSecret(): OneTimeSecret | null {
  try {
    const raw = window.sessionStorage.getItem(SECRET_STASH_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed &&
      typeof (parsed as OneTimeSecret).scannerId === "string" &&
      typeof (parsed as OneTimeSecret).secret === "string"
    ) {
      return parsed as OneTimeSecret;
    }
  } catch {
    /* unavailable or malformed — fall through */
  }
  return null;
}

export function useOneTimeSecret() {
  const [oneTimeSecret, setState] = useState<OneTimeSecret | null>(null);

  // Read after mount rather than in a lazy initializer: the server renders with
  // no stash, so seeding state from it directly would be a hydration mismatch.
  useEffect(() => {
    const stashed = readStashedSecret();
    if (stashed) setState(stashed);
  }, []);

  const setOneTimeSecret = useCallback((next: OneTimeSecret | null) => {
    setState(next);
    try {
      if (next) window.sessionStorage.setItem(SECRET_STASH_KEY, JSON.stringify(next));
      else window.sessionStorage.removeItem(SECRET_STASH_KEY);
    } catch {
      /* storage unavailable — the panel still works for this render */
    }
  }, []);

  return { oneTimeSecret, setOneTimeSecret };
}

/** A labelled value with a Copy button. */
export function SetupField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-primary/50">{label}</p>
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code
        className={`mt-1 block break-all rounded-md border border-primary/10 bg-white px-3 py-2 text-sm text-primary ${mono ? "font-mono" : ""}`}
      >
        {value}
      </code>
    </div>
  );
}

/** The one and only chance to read a key — shown after create or rotate. */
export function OneTimeSecretPanel({
  secret,
  scannerLabel,
  onDone,
}: {
  secret: string;
  scannerLabel: string;
  onDone: () => void;
}) {
  return (
    <div className="card border-accent/40 bg-accent/10 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-primary">
          Set up the security device — scanner “{scannerLabel}”
        </p>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
      <p className="mt-1 text-xs text-primary/55">
        Enter this key on the device’s Activate screen — it identifies the scanner on its own, so there
        is nothing else to configure. Only a one-way hash is stored, so this is the one and only time
        the key can be read: once you press Done it is gone, and a lost key can only be replaced by
        generating a new one.
      </p>
      <SetupField label="Scanner Key" value={secret} mono />
    </div>
  );
}

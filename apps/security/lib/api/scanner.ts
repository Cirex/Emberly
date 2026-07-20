import { SCANNER_KEY_HEADER } from "@emberly/core";
import { z } from "zod";
import { handleUnauthorizedScannerKey } from "@/lib/stores/config";

/**
 * Wire config for authenticated scanner calls. The scanner key self-identifies —
 * the server resolves the device by hashing it — so no scanner id is sent.
 */
export interface ScannerConfig {
  baseUrl: string;
  scannerKey: string;
}

export const VehicleSchema = z.object({
  make: z.string(),
  model: z.string(),
  color: z.string(),
  plate: z.string(),
});
export type Vehicle = z.infer<typeof VehicleSchema>;

/** Response of POST /api/verify-pass (mirrors the route's VerifyResponse). */
export const VerifyResponseSchema = z.object({
  valid: z.boolean(),
  tenantName: z.string().optional(),
  unitAddress: z.string().optional(),
  propertyName: z.string().optional(),
  vehicles: z.array(VehicleSchema).optional(),
  entryType: z.enum(["resident", "guest"]).optional(),
  entryLogId: z.string().optional(),
  reason: z.string().optional(),
  reasonCode: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

function authHeaders(config: ScannerConfig): Record<string, string> {
  // The route accepts either `Authorization: Bearer` or the x-scanner-key header.
  return {
    Authorization: `Bearer ${config.scannerKey}`,
    [SCANNER_KEY_HEADER]: config.scannerKey,
  };
}

export type KeyCheck =
  | { ok: true }
  | { ok: false; reason: "rejected" | "unreachable" };

/**
 * Prove a key works before it is stored, so activation fails on the setup screen
 * rather than silently letting the device in to error on every screen after.
 *
 * There is no dedicated validation endpoint, so this borrows the cheapest
 * authenticated read there is. One key authorizes every surface, so proving it
 * against this route proves it for all of them.
 *
 * "rejected" and "unreachable" are kept apart deliberately: a bad key and a
 * missing network need opposite things from whoever is holding the device.
 */
export async function checkScannerKey(config: ScannerConfig): Promise<KeyCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${config.baseUrl}/api/resman/units?limit=1`, {
      headers: authHeaders(config),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "rejected" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Verify a scanned QR token. Throws only on network/transport failure. */
export async function verifyPass(token: string, config: ScannerConfig): Promise<VerifyResponse> {
  // A stalled connection must not wedge the gate scanner in "verifying" forever
  // (there is no reset path from that phase). Bound the request like
  // checkScannerKey does; an abort throws → the store lands on the "unable"
  // phase, from which the guard can rescan.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/api/verify-pass`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(config) },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const json = await res
    .json()
    .catch(() => ({ valid: false, reason: "Malformed response", reasonCode: "verification_error" }));
  return VerifyResponseSchema.parse(json);
}

/** Upload an entry-log photo (multipart JPEG). Throws on non-2xx. */
export async function uploadEntryPhoto(
  entryLogId: string,
  fileUri: string,
  config: ScannerConfig,
): Promise<void> {
  const form = new FormData();
  // React Native's FormData accepts the {uri,name,type} file shape.
  form.append("photo", { uri: fileUri, name: "entry.jpg", type: "image/jpeg" } as unknown as Blob);
  const url = `${config.baseUrl}/api/entry-logs/${entryLogId}/photos`;
  // Bound the upload too, so a stalled connection surfaces as a thrown error
  // rather than an open request the caller awaits forever. Generous (30s) since
  // this is a multipart JPEG on possibly-slow gate wifi.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: authHeaders(config),
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Photo upload failed (${res.status})`);
}

/** reasonCode → human title + whether it's a scanner-configuration problem. */
export const REASON_DISPLAY: Record<string, { title: string; config?: boolean }> = {
  scanner_auth_required: { title: "Scanner setup required", config: true },
  scanner_disabled: { title: "Scanner disabled", config: true },
  rate_limited: { title: "Too many attempts" },
  unsupported_qr: { title: "Unrecognized code" },
  invalid_or_expired_code: { title: "Invalid or expired code" },
  pass_not_found: { title: "Pass not found" },
  guest_pass_revoked: { title: "Pass revoked" },
  guest_pass_used: { title: "Pass already used" },
  guest_pass_expired: { title: "Pass expired" },
  guest_pass_consumed: { title: "Pass already consumed" },
  resident_entry_replayed: { title: "Code already used" },
  resident_not_found: { title: "Resident not found" },
  resident_access_denied: { title: "Access denied" },
  resident_access_stale: { title: "Resident must re-verify" },
  entry_log_failed: { title: "Entry could not be logged" },
  verification_error: { title: "Verification error" },
  server_error: { title: "Server error" },
  invalid_request: { title: "Invalid request" },
};

export function reasonTitle(code?: string, fallback?: string): string {
  if (code && REASON_DISPLAY[code]) return REASON_DISPLAY[code].title;
  return fallback ?? "Access denied";
}

export function isConfigReason(code?: string): boolean {
  return !!code && !!REASON_DISPLAY[code]?.config;
}

const ScanCountsSchema = z.object({
  scans: z.number(),
  entries: z.number(),
  guest: z.number(),
  refused: z.number(),
});
export type ScanCounts = z.infer<typeof ScanCountsSchema>;

export const ScannerProfileSchema = z.object({
  data: z.object({
    scanner: z.object({
      id: z.string(),
      name: z.string(),
      location: z.string().nullable(),
      activeSince: z.string().nullable(),
    }),
    today: ScanCountsSchema,
    total: ScanCountsSchema,
  }),
});
export type ScannerProfile = z.infer<typeof ScannerProfileSchema>["data"];

/** This device's identity and scan counts (settings page). */
export async function getScannerProfile(config: ScannerConfig): Promise<ScannerProfile> {
  const res = await fetch(`${config.baseUrl}/api/scanner/me`, { headers: authHeaders(config) });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) handleUnauthorizedScannerKey();
    throw new Error("Scanner not authorized");
  }
  if (!res.ok) throw new Error(`Failed to load scanner profile (${res.status})`);
  return ScannerProfileSchema.parse(await res.json()).data;
}

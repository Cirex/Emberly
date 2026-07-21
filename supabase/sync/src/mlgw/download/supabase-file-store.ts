/**
 * Storage-backed `BillFileStore` — uploads bill bytes to the Supabase
 * `mlgw-bills` bucket so the admin portal can serve invoices via signed URLs
 * (GET /api/admin/utilities/invoice/[billId]).
 *
 * Policy: only PDFs are invoices. When MLGW doesn't offer a real PDF, the
 * bill-document endpoint returns the "My Account" SPA shell with no bill
 * content (verified against 2,840 byte-identical HTML captures in XMS's
 * store), so non-PDF puts persist nothing and return "" — the imported bill
 * then carries an empty file_path, which the portal renders as the disabled
 * "No invoice file" state.
 *
 * Upload failures also resolve to "" after logging: a missing invoice file
 * must never fail the bill import itself.
 */

import type { ServiceClient } from "../../db/client";
import type { BillFileStore } from "./file-store";

export const MLGW_BILLS_BUCKET = "mlgw-bills";

export class SupabaseStorageBillFileStore implements BillFileStore {
  /** Paths claimed this run, for the same `-2`…`-200` clash handling as the in-memory store. */
  private readonly claimed = new Set<string>();

  constructor(
    private readonly client: ServiceClient,
    private readonly bucket: string = MLGW_BILLS_BUCKET,
    private readonly log: (message: string) => void = (m) => console.warn(m),
  ) {}

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<string> {
    if (contentType !== "application/pdf") return "";
    const unique = this.uniquePath(path);
    this.claimed.add(unique);
    try {
      const { error } = await this.client.storage
        .from(this.bucket)
        .upload(unique, new Blob([bytes as unknown as ArrayBuffer], { type: contentType }), {
          contentType,
          upsert: true,
        });
      if (error) {
        this.log(`[mlgw-bills] upload failed for ${unique}: ${error.message}`);
        return "";
      }
      return unique;
    } catch (error) {
      this.log(`[mlgw-bills] upload failed for ${unique}: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  private uniquePath(path: string): string {
    if (!this.claimed.has(path)) return path;
    const dot = path.lastIndexOf(".");
    const hasExt = dot > 0;
    const base = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot + 1) : "";
    for (let suffix = 2; suffix <= 200; suffix += 1) {
      const candidate = ext.length === 0 ? `${base}-${suffix}` : `${base}-${suffix}.${ext}`;
      if (!this.claimed.has(candidate)) return candidate;
    }
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const uuid = webCrypto?.randomUUID?.() ?? String(Date.now());
    return `${base}-${uuid}.${ext}`;
  }
}

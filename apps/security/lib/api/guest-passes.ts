import { SCANNER_KEY_HEADER } from "@emberly/core";
import { z } from "zod";
import { handleUnauthorizedScannerKey } from "@/lib/stores/config";

export interface AdminConfig {
  baseUrl: string;
  scannerKey: string;
}

export const PassStatusSchema = z.enum(["active", "used", "expired", "revoked"]);
export type PassStatus = z.infer<typeof PassStatusSchema>;

const ResidentSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit_id: z.string().nullable().optional(),
});

// The API returns `residents` as either a single object or an array.
const ResidentsSchema = z.union([ResidentSchema, z.array(ResidentSchema)]).nullable().optional();

export const GuestPassSchema = z.object({
  id: z.string(),
  guest_name: z.string(),
  guest_email: z.string().nullable().optional(),
  guest_phone: z.string().nullable().optional(),
  guest_address: z.string().nullable().optional(),
  share_url: z.string().nullable().optional(),
  expires_at: z.string(),
  used_at: z.string().nullable().optional(),
  created_at: z.string(),
  status: PassStatusSchema,
  residents: ResidentsSchema,
  photo_count: z.number().nullable().optional(),
});
export type GuestPass = z.infer<typeof GuestPassSchema>;

export const PaginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

export const FeedSchema = z.object({
  passes: z.array(GuestPassSchema),
  pagination: PaginationSchema,
});
export type Feed = z.infer<typeof FeedSchema>;

/** Normalize the one-or-many `residents` value to an array. */
export function residentList(pass: GuestPass): Array<z.infer<typeof ResidentSchema>> {
  if (!pass.residents) return [];
  return Array.isArray(pass.residents) ? pass.residents : [pass.residents];
}

export async function listGuestPasses(
  params: { page?: number; limit?: number; status?: PassStatus; search?: string },
  config: AdminConfig,
): Promise<Feed> {
  const q = new URLSearchParams();
  if (params.page) q.set("page", String(params.page));
  if (params.limit) q.set("limit", String(params.limit));
  if (params.status) q.set("status", params.status);
  if (params.search?.trim()) q.set("search", params.search.trim());

  const res = await fetch(`${config.baseUrl}/api/admin/guest-passes?${q.toString()}`, {
    headers: {
      Authorization: `Bearer ${config.scannerKey}`,
      [SCANNER_KEY_HEADER]: config.scannerKey,
    },
  });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) handleUnauthorizedScannerKey();
    throw new Error("Scanner not authorized");
  }
  if (!res.ok) throw new Error(`Failed to load guest passes (${res.status})`);
  return FeedSchema.parse(await res.json());
}

export async function revokeGuestPass(id: string, config: AdminConfig): Promise<void> {
  const res = await fetch(`${config.baseUrl}/api/admin/guest-passes/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.scannerKey}`,
      [SCANNER_KEY_HEADER]: config.scannerKey,
    },
    body: JSON.stringify({ status: "revoked" }),
  });
  if (!res.ok) throw new Error(`Failed to revoke pass (${res.status})`);
}

import { getGuestPassStatus } from "@/lib/admin-data";
import { normalizeAdminGuestPassSearch } from "@/lib/admin-search";
import { buildGuestPassUrl } from "@/lib/guest-pass-share";
import { createAdminClient } from "@/lib/supabase/admin";

export type PassStatus = "active" | "used" | "expired" | "revoked";

export interface GuestPassRow {
  id: string;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  guest_address: string | null;
  share_url?: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  status: PassStatus;
  residents:
    | {
        id: string;
        name: string;
        unit_id: string;
      }
    | Array<{
        id: string;
        name: string;
        unit_id: string;
      }>
    | null;
}

export interface AdminPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export type AdminGuestPassesResult = {
  passes: GuestPassRow[];
  pagination: AdminPagination;
};

export type ListAdminGuestPassesParams = {
  page?: number;
  limit?: number;
  status?: PassStatus;
  search?: string;
  requestUrl?: string;
};

export async function listAdminGuestPasses({
  page = 1,
  limit = 50,
  status,
  search,
  requestUrl,
}: ListAdminGuestPassesParams = {}): Promise<AdminGuestPassesResult> {
  const normalizedSearch = normalizeAdminGuestPassSearch(search);
  if (search && !normalizedSearch) {
    throw new Error("Invalid search query");
  }

  const offset = (page - 1) * limit;
  const now = new Date();
  const nowIso = now.toISOString();
  const supabase = createAdminClient();

  let query = supabase
    .from("guest_passes")
    .select(
      `
      id,
      guest_name,
      guest_email,
      guest_phone,
      guest_address,
      share_token,
      expires_at,
      used_at,
      status,
      created_at,
      residents (
        id,
        name,
        unit_id
      )
    `,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (normalizedSearch) {
    query = query.or(`guest_name.ilike.%${normalizedSearch}%,guest_email.ilike.%${normalizedSearch}%`);
  }

  // These filters encode the same status precedence as getGuestPassStatus in
  // @emberly/core (revoked > used > expired > active), expressed as Supabase
  // query conditions since the TS function cannot run inside the database
  // query. Keep them in sync with the shared source of truth.
  if (status === "active") {
    query = query.eq("status", "active").is("used_at", null).gte("expires_at", nowIso);
  } else if (status === "used") {
    query = query.eq("status", "used");
  } else if (status === "expired") {
    query = query.eq("status", "active").is("used_at", null).lt("expires_at", nowIso);
  } else if (status === "revoked") {
    query = query.eq("status", "revoked");
  }

  const { data, error, count } = await query;
  if (error) {
    console.error("[admin/guest-passes] Query error:", error);
    throw new Error("Failed to fetch guest passes");
  }

  const total = count ?? 0;
  const totalPages = Math.ceil(total / limit);
  const passes = ((data ?? []) as Array<Omit<GuestPassRow, "status" | "share_url"> & {
    share_token?: string;
    status: "active" | "used" | "revoked";
  }>).map(({ share_token, ...pass }) => ({
    ...pass,
    ...(requestUrl && share_token ? { share_url: buildGuestPassUrl(requestUrl, share_token) } : {}),
    status: getGuestPassStatus(pass, now),
  }));

  return {
    passes,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The private ResMan REST API (apps/web lib/resman-api-auth.ts) authenticates
 * this app with the signed-in staff member's per-user `eapi_` token as a
 * Bearer credential. The server resolves the person from the token, so every
 * request is attributed to whoever is signed in.
 */
export type ResmanConfig = StaffConfig;

const num = z.number().nullable().optional();
const str = z.string().nullable().optional();

/**
 * A row from GET /api/resman/units (resman_units mirror table). The FULL DTO
 * is kept on purpose: the property map needs occupancy/classification, the
 * delinquency board needs balances, and leasing needs lease/move dates.
 */
export const ResmanUnitSchema = z.object({
  resman_unit_id: z.string(),
  resman_property_id: str,
  resman_building_id: str,
  number: z.string().default(""),
  availability: str,
  lease_status: str,
  occupancy_status: str,
  classification: str,
  notes: str,
  occupied: z.boolean().nullable().optional(),
  market_rent: num,
  lease_rent: num,
  balance: num,
  bedrooms: num,
  bathrooms: num,
  holding_unit: z.boolean().nullable().optional(),
  excluded_from_occupancy: z.boolean().nullable().optional(),
  street: str,
  city: str,
  state: str,
  postal_code: str,
  tenant_names: z.array(z.string()).default([]),
  lease_start_date: str,
  lease_end_date: str,
  move_in_date: str,
  move_out_date: str,
  source_url: str,
  scraped_at: str,
  synced_at: str,
});
export type ResmanUnit = z.infer<typeof ResmanUnitSchema>;

export const ResmanListSchema = z.object({
  data: z.array(ResmanUnitSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    count: z.number(),
    hasMore: z.boolean(),
  }),
});
export type ResmanList = z.infer<typeof ResmanListSchema>;

export async function listUnits(
  params: { limit?: number; offset?: number },
  config: ResmanConfig,
): Promise<ResmanList> {
  const q = new URLSearchParams();
  q.set("limit", String(params.limit ?? 200));
  if (params.offset) q.set("offset", String(params.offset));

  const json = await apiJson(`/api/resman/units?${q.toString()}`, config);
  return ResmanListSchema.parse(json);
}

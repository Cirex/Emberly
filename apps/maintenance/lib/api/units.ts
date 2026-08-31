import { z } from "zod";
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

/** A row from GET /api/resman/units (resman_units mirror table). */
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
  // The delta cursor the units store pages against (?updated_since=). COLUMNS
  // is derived from these keys, so it must be requested to come back.
  updated_at: str,
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

export type OccupancyFilter = "Occupied" | "Vacant" | "Notice";

/**
 * Lease status is the finer cut. ResMan's occupancy lumps both of these under
 * "Notice", so it's the only way to separate a tenant who gave notice from one
 * being evicted.
 */
export type LeaseStatusFilter = "Notice to Vacate" | "Under Eviction";

/**
 * Exactly the columns this module parses, derived from the schema so a field
 * added to one cannot go missing from the other.
 *
 * Without a `columns` param the server answers with the resource's
 * `defaultColumns` — a curated subset that withholds street/city/state, classification, bedroom and bathroom counts and
 * `synced_at` — 17 of the 29 fields below.
 * The withheld fields then arrive undefined and this schema's
 * optional/default declarations absorb them without complaint: no parse error,
 * no warning, just empty values reaching the UI.
 *
 * The server intersects this list against its own public columns, so naming a
 * field it does not expose is ignored rather than an error.
 */
const COLUMNS = Object.keys(ResmanUnitSchema.shape).join(",");

export async function listUnits(
  params: {
    limit?: number;
    offset?: number;
    occupancy_status?: OccupancyFilter;
    lease_status?: LeaseStatusFilter;
    /** ISO-8601; ask the server for rows whose updated_at is newer. */
    updatedSince?: string;
  },
  config: ResmanConfig,
): Promise<ResmanList> {
  const q = new URLSearchParams();
  q.set("limit", String(params.limit ?? 200));
  q.set("columns", COLUMNS);
  if (params.offset) q.set("offset", String(params.offset));
  if (params.occupancy_status) q.set("occupancy_status", params.occupancy_status);
  if (params.lease_status) q.set("lease_status", params.lease_status);
  if (params.updatedSince) q.set("updated_since", params.updatedSince);

  const res = await fetch(`${config.baseUrl}/api/resman/units?${q.toString()}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (res.status === 401 || res.status === 403)
    throw new Error("Not authorized for the ResMan API");
  if (!res.ok) throw new Error(`Failed to load units (${res.status})`);
  return ResmanListSchema.parse(await res.json());
}

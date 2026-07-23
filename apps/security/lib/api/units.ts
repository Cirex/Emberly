import { SCANNER_KEY_HEADER } from "@emberly/core";
import { z } from "zod";
import { handleUnauthorizedScannerKey } from "@/lib/stores/config";

/**
 * The private ResMan REST API (apps/web lib/resman-api-auth.ts) authenticates a
 * scanner with its secret (Bearer / x-scanner-key) — the same self-identifying
 * per-scanner key used to verify passes. The server resolves the device from the
 * key, so no scanner id is sent.
 */
export interface ResmanConfig {
  baseUrl: string;
  scannerKey: string;
}

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

const GuestBansSchema = z.object({
  data: z.object({ unitNumbers: z.array(z.string()) }),
});

const MetricsSchema = z.object({
  data: z.object({
    entriesToday: z.number(),
    entriesGuestsToday: z.number(),
    vehicleCount: z.number(),
  }),
});
export type PropertyMetrics = z.infer<typeof MetricsSchema>["data"];

/** Property-wide headline counts for the tenant dashboard cards (one request). */
export async function getPropertyMetrics(config: ResmanConfig): Promise<PropertyMetrics> {
  const res = await fetch(`${config.baseUrl}/api/resman/metrics`, {
    headers: {
      Authorization: `Bearer ${config.scannerKey}`,
      [SCANNER_KEY_HEADER]: config.scannerKey,
    },
  });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) handleUnauthorizedScannerKey();
    throw new Error("Scanner not authorized for the ResMan API");
  }
  if (!res.ok) throw new Error(`Failed to load metrics (${res.status})`);
  return MetricsSchema.parse(await res.json()).data;
}

/**
 * Unit numbers where guest visits are disabled — unit-level suspensions plus
 * resident-level bans, unioned server-side. Backs the "No Guests" filter chip.
 */
export async function listGuestBannedUnits(config: ResmanConfig): Promise<string[]> {
  const res = await fetch(`${config.baseUrl}/api/resman/units/guest-bans`, {
    headers: {
      Authorization: `Bearer ${config.scannerKey}`,
      [SCANNER_KEY_HEADER]: config.scannerKey,
    },
  });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) handleUnauthorizedScannerKey();
    throw new Error("Scanner not authorized for the ResMan API");
  }
  if (!res.ok) throw new Error(`Failed to load guest bans (${res.status})`);
  return GuestBansSchema.parse(await res.json()).data.unitNumbers;
}

export async function listUnits(
  params: {
    limit?: number;
    offset?: number;
    occupancy_status?: OccupancyFilter;
    lease_status?: LeaseStatusFilter;
  },
  config: ResmanConfig,
): Promise<ResmanList> {
  const q = new URLSearchParams();
  q.set("limit", String(params.limit ?? 200));
  if (params.offset) q.set("offset", String(params.offset));
  if (params.occupancy_status) q.set("occupancy_status", params.occupancy_status);
  if (params.lease_status) q.set("lease_status", params.lease_status);

  const res = await fetch(`${config.baseUrl}/api/resman/units?${q.toString()}`, {
    headers: {
      Authorization: `Bearer ${config.scannerKey}`,
      [SCANNER_KEY_HEADER]: config.scannerKey,
    },
  });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) handleUnauthorizedScannerKey();
    throw new Error("Scanner not authorized for the ResMan API");
  }
  if (!res.ok) throw new Error(`Failed to load units (${res.status})`);
  return ResmanListSchema.parse(await res.json());
}

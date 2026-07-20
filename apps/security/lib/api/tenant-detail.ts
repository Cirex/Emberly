import { SCANNER_KEY_HEADER } from "@emberly/core";
import { z } from "zod";
import { handleUnauthorizedScannerKey } from "@/lib/stores/config";
import type { ScannerConfig } from "./scanner";

export const TenantVehicleSchema = z.object({
  id: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.string(),
  color: z.string(),
  licensePlate: z.string(),
  licensePlateState: z.string(),
  parkingSpot: z.string(),
});
export type TenantVehicle = z.infer<typeof TenantVehicleSchema>;

export const TenantLastEntrySchema = z.object({
  id: z.string(),
  entryType: z.enum(["resident", "guest"]),
  tenantName: z.string(),
  enteredAt: z.string().nullable(),
});
export type TenantLastEntry = z.infer<typeof TenantLastEntrySchema>;

export const TenantGuestPassSchema = z.object({
  id: z.string(),
  guestName: z.string(),
  /** The resident who issued it. */
  hostName: z.string(),
  expiresAt: z.string(),
  createdAt: z.string().nullable(),
});
export type TenantGuestPass = z.infer<typeof TenantGuestPassSchema>;

/** The raw counts behind "Guests Allowed"; `guestsAllowedLabel` renders the verdict. */
export const TenantGuestAccessSchema = z.object({
  /** Residents enrolled against this unit. */
  residents: z.number(),
  /** Of those, how many may host: access_allowed AND not blocked. */
  allowed: z.number(),
  /** Of those, how many an admin has blocked from issuing passes. */
  banned: z.number(),
});
export type TenantGuestAccess = z.infer<typeof TenantGuestAccessSchema>;

export const TenantDetailSchema = z.object({
  data: z.object({
    vehicles: z.array(TenantVehicleSchema),
    lastEntry: TenantLastEntrySchema.nullable(),
    /** Only passes that are neither revoked/used nor past their expiry. */
    guestPasses: z.array(TenantGuestPassSchema),
    guestAccess: TenantGuestAccessSchema,
  }),
});
export type TenantDetail = z.infer<typeof TenantDetailSchema>["data"];

/**
 * The per-unit facts the list endpoint doesn't carry: vehicles (two joins off
 * the unit's current lease) and the most recent entry for the unit.
 */
export async function getTenantDetail(
  unitId: string,
  config: ScannerConfig,
): Promise<TenantDetail> {
  const res = await fetch(`${config.baseUrl}/api/resman/units/${encodeURIComponent(unitId)}/detail`, {
    headers: {
      Authorization: `Bearer ${config.scannerKey}`,
      [SCANNER_KEY_HEADER]: config.scannerKey,
    },
  });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) handleUnauthorizedScannerKey();
    throw new Error("Scanner not authorized for the ResMan API");
  }
  if (!res.ok) throw new Error(`Failed to load tenant details (${res.status})`);
  return TenantDetailSchema.parse(await res.json()).data;
}

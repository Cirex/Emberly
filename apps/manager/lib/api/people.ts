import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * People directory + tenant profile reads.
 *
 *   GET /api/resman/manager/people      → the search INDEX (one small row per
 *       resident: name, unit, phones, email, plates). Small enough to cache on
 *       device, which is what makes name/unit/phone/plate search work offline
 *       and instantly.
 *   GET /api/resman/manager/people/:id  → one full profile.
 *
 * PII CONTRACT — what this actually promises. The index is NOT "PII-free": a
 * name, unit number, phone, email and licence plate per resident is personal
 * data by any definition, and it is the payload that gets written to disk. What
 * the contract excludes is the SENSITIVE tier — birthdate, driver's licence and
 * income are ABSENT from both default payloads. Those arrive only when
 * `fetchTenantProfile` is called with `includePii`, which the UI does exactly
 * once per masked field the manager taps, and the server writes an
 * admin_audit_logs row for each such call. The always-present
 * `rentToIncomeRatio` is the affordability answer that needs no salary
 * disclosure.
 *
 * Because the index IS personal data at rest, sign-out purges it — see
 * lib/session-data.ts. Profiles are never persisted at all.
 */

const num = z.number().nullable().optional();
const str = z.string().nullable().optional();

export const PeopleIndexVehicleSchema = z.object({
  plate: z.string().default(""),
  state: z.string().default(""),
});
export type PeopleIndexVehicle = z.infer<typeof PeopleIndexVehicleSchema>;

export const PeopleIndexEntrySchema = z.object({
  personLeaseId: z.string(),
  personId: z.string().default(""),
  leaseId: z.string().default(""),
  unitNumber: z.string().default(""),
  firstName: z.string().default(""),
  lastName: z.string().default(""),
  isPrimary: z.boolean().default(false),
  householdStatus: z.string().default(""),
  phones: z.array(z.string()).default([]),
  email: z.string().default(""),
  vehicles: z.array(PeopleIndexVehicleSchema).default([]),
});
export type PeopleIndexEntry = z.infer<typeof PeopleIndexEntrySchema>;

export const TenantResidentSchema = z.object({
  personLeaseId: z.string(),
  personId: z.string().default(""),
  leaseId: z.string().default(""),
  firstName: z.string().default(""),
  lastName: z.string().default(""),
  email: z.string().default(""),
  phones: z.array(z.string()).default([]),
  gender: z.string().default(""),
  householdStatus: z.string().default(""),
  language: z.string().default(""),
  identification: z.string().default(""),
  isPrimary: z.boolean().default(false),
  // PII — only present on an includePii response.
  birthdate: str,
  driversLicense: z.string().optional(),
  driversLicenseState: z.string().optional(),
});
export type TenantResident = z.infer<typeof TenantResidentSchema>;

export const TenantLeaseSchema = z.object({
  leaseId: z.string().default(""),
  unitId: str,
  unitNumber: z.string().default(""),
  status: z.string().default(""),
  classification: z.string().default(""),
  bedrooms: num,
  moveInDate: str,
  moveOutDate: str,
  leaseStart: str,
  leaseEnd: str,
  residentRent: num,
  marketRent: num,
  balance: num,
  timesLate: num,
  leasingAgent: z.string().default(""),
});
export type TenantLease = z.infer<typeof TenantLeaseSchema>;

export const TenantHouseholdMemberSchema = z.object({
  personLeaseId: z.string(),
  firstName: z.string().default(""),
  lastName: z.string().default(""),
  isPrimary: z.boolean().default(false),
  householdStatus: z.string().default(""),
  phones: z.array(z.string()).default([]),
  email: z.string().default(""),
});
export type TenantHouseholdMember = z.infer<typeof TenantHouseholdMemberSchema>;

export const TenantVehicleSchema = z.object({
  id: z.string(),
  make: z.string().default(""),
  model: z.string().default(""),
  year: z.string().default(""),
  color: z.string().default(""),
  plate: z.string().default(""),
  state: z.string().default(""),
  parkingSpot: z.string().default(""),
});
export type TenantVehicle = z.infer<typeof TenantVehicleSchema>;

export const TenantInsuranceSchema = z.object({
  id: z.string(),
  provider: z.string().default(""),
  policyNumber: z.string().default(""),
  policyType: z.string().default(""),
  status: z.string().default(""),
  startDate: str,
  endDate: str,
  coverageAmount: num,
});
export type TenantInsurance = z.infer<typeof TenantInsuranceSchema>;

export const TenantEmploymentSchema = z.object({
  id: z.string(),
  employerName: z.string().default(""),
  position: z.string().default(""),
  phone: z.string().default(""),
  otherIncomeSource: z.string().default(""),
  startDate: str,
  // PII — only present on an includePii response.
  monthlyIncome: num,
  otherIncome: num,
});
export type TenantEmployment = z.infer<typeof TenantEmploymentSchema>;

export const TenantContactSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  relationship: z.string().default(""),
  phone: z.string().default(""),
  email: z.string().default(""),
  isEmergencyContact: z.boolean().default(false),
});
export type TenantContact = z.infer<typeof TenantContactSchema>;

export const TenantAddressSchema = z.object({
  id: z.string(),
  addressType: z.string().default(""),
  street: z.string().default(""),
  city: z.string().default(""),
  state: z.string().default(""),
  postalCode: z.string().default(""),
  country: z.string().default(""),
  startDate: str,
  endDate: str,
});
export type TenantAddress = z.infer<typeof TenantAddressSchema>;

export const TenantWorkOrderSchema = z.object({
  id: z.string(),
  number: z.string().default(""),
  title: z.string().default(""),
  status: z.string().default(""),
  priority: z.string().default(""),
  category: z.string().default(""),
  technician: z.string().default(""),
  dateReported: str,
  dateCompleted: str,
  callbackStatus: z.string().default("none"),
});
export type TenantWorkOrder = z.infer<typeof TenantWorkOrderSchema>;

export const TenantProfileSchema = z.object({
  resident: TenantResidentSchema,
  lease: TenantLeaseSchema.nullable(),
  household: z.array(TenantHouseholdMemberSchema).default([]),
  vehicles: z.array(TenantVehicleSchema).default([]),
  insurance: z.array(TenantInsuranceSchema).default([]),
  employment: z.array(TenantEmploymentSchema).default([]),
  alternateContacts: z.array(TenantContactSchema).default([]),
  addresses: z.array(TenantAddressSchema).default([]),
  workOrders: z.array(TenantWorkOrderSchema).default([]),
  rentToIncomeRatio: num,
  piiIncluded: z.boolean().default(false),
});
export type TenantProfile = z.infer<typeof TenantProfileSchema>;

const IndexEnvelopeSchema = z.object({ data: z.object({ people: z.array(PeopleIndexEntrySchema) }) });
const ProfileEnvelopeSchema = z.object({ data: z.object({ profile: TenantProfileSchema }) });

/** The whole directory index. Throws ApiError / ZodError; callers contain. */
export async function fetchPeopleIndex(config: StaffConfig): Promise<PeopleIndexEntry[]> {
  const json = await apiJson("/api/resman/manager/people", config);
  return IndexEnvelopeSchema.parse(json).data.people;
}

export interface TenantProfileOptions {
  /**
   * Ask for the masked fields (birthdate, licence, income). The SERVER writes
   * an audit-log row for every such request — never set this speculatively,
   * only in direct response to a manager tapping "reveal".
   */
  includePii?: boolean;
  /** Which masked field the manager tapped, recorded in the audit row. */
  field?: string;
}

/** One tenant profile. `includePii` is audited server-side — see above. */
export async function fetchTenantProfile(
  config: StaffConfig,
  personLeaseId: string,
  options: TenantProfileOptions = {},
): Promise<TenantProfile> {
  const query = new URLSearchParams();
  if (options.includePii) query.set("includePii", "1");
  if (options.field) query.set("field", options.field);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const json = await apiJson(
    `/api/resman/manager/people/${encodeURIComponent(personLeaseId)}${suffix}`,
    config,
  );
  return ProfileEnvelopeSchema.parse(json).data.profile;
}

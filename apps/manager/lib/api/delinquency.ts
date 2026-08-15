import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Delinquency (Money) feature API: the delinquency board feed (units that owe
 * or carry a reason note + the Emberly-owned action timeline), the per-lease
 * ledger mirror (summary + drill-in), and a THIN read of the manager lease
 * window for agent scorecards. The lease fetch is deliberately duplicated
 * here rather than importing the Leasing feature's module — the two features
 * stay decoupled and each owns its own wire schema.
 */

// ---- delinquency board -----------------------------------------------------

const num = z.number().nullable().optional();

export const DelinquentUnitSchema = z.object({
  unitId: z.string(),
  unitNumber: z.string().default(""),
  tenantNames: z.array(z.string()).default([]),
  balance: num,
  currentMonthBalance: num,
  lastMonthBalance: num,
  periodBalance: num,
  previousBalance: num,
  timesLate: num,
  delinquencyReason: z.string().default(""),
  leasingAgent: z.string().default(""),
  currentLeaseId: z.string().nullable().optional(),
  marketRent: num,
});
export type DelinquentUnit = z.infer<typeof DelinquentUnitSchema>;

export const DELINQUENCY_ACTION_KINDS = [
  "note",
  "called",
  "notice_served",
  "promise_recorded",
  "promise_kept",
  "promise_broken",
  "fed_filed",
  "eviction_completed",
  "writeoff",
  "payment_plan",
] as const;
export type DelinquencyActionKind = (typeof DELINQUENCY_ACTION_KINDS)[number];

/** The only kinds allowed to carry a promiseDueDate (server-enforced too). */
export const PROMISE_DATED_KINDS: ReadonlySet<DelinquencyActionKind> = new Set([
  "promise_recorded",
  "payment_plan",
]);

export const DelinquencyActionSchema = z.object({
  id: z.string(),
  resmanLeaseId: z.string(),
  resmanUnitId: z.string().default(""),
  unitNumber: z.string().default(""),
  kind: z.enum(DELINQUENCY_ACTION_KINDS),
  note: z.string().default(""),
  amount: num,
  promiseDueDate: z.string().nullable().optional(),
  createdBy: z.string().default(""),
  createdAt: z.string().nullable().optional(),
});
export type DelinquencyAction = z.infer<typeof DelinquencyActionSchema>;

const BoardSchema = z.object({
  data: z.object({
    units: z.array(DelinquentUnitSchema),
    actions: z.array(DelinquencyActionSchema),
  }),
});
export type DelinquencyBoard = z.infer<typeof BoardSchema>["data"];

/** The full board feed: delinquent units + their action timeline, one shot. */
export async function fetchDelinquencyBoard(config: StaffConfig): Promise<DelinquencyBoard> {
  const json = await apiJson("/api/resman/manager/delinquency", config);
  return BoardSchema.parse(json).data;
}

export interface DelinquencyActionInput {
  resmanLeaseId: string;
  resmanUnitId?: string;
  unitNumber?: string;
  kind: DelinquencyActionKind;
  note?: string;
  amount?: number;
  /** "YYYY-MM-DD"; only valid for promise_recorded / payment_plan. */
  promiseDueDate?: string;
}

const CreatedSchema = z.object({ data: DelinquencyActionSchema });

/** Record one collections action; returns the stored server row. */
export async function createDelinquencyAction(
  config: StaffConfig,
  input: DelinquencyActionInput,
): Promise<DelinquencyAction> {
  const json = await apiJson("/api/resman/manager/delinquency-actions", config, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return CreatedSchema.parse(json).data;
}

/** Soft-delete one action (undo for a mistaken log entry). */
export async function deleteDelinquencyAction(config: StaffConfig, id: string): Promise<void> {
  await apiJson(`/api/resman/manager/delinquency-actions/${encodeURIComponent(id)}`, config, {
    method: "DELETE",
  });
}

// ---- lease ledger ----------------------------------------------------------

export const LeaseLedgerSummarySchema = z.object({
  leaseId: z.string(),
  billed: z.number(),
  collected: z.number(),
  lastPaymentDate: z.string().nullable().optional(),
  firstLateMonth: z.string().nullable().optional(),
  /** Net concession value (credits − charges over concession entries). */
  concessions: z.number(),
  /** Net write-off value (credits − charges over write-off entries). */
  writeoffs: z.number(),
});
export type LeaseLedgerSummary = z.infer<typeof LeaseLedgerSummarySchema>;

const LedgerSummaryResponseSchema = z.object({
  data: z.object({ leases: z.array(LeaseLedgerSummarySchema) }),
});

/** One aggregate row per lease over the whole transactions mirror. */
export async function fetchLedgerSummary(config: StaffConfig): Promise<LeaseLedgerSummary[]> {
  const json = await apiJson("/api/resman/manager/ledger-summary", config);
  return LedgerSummaryResponseSchema.parse(json).data.leases;
}

export const LedgerEntrySchema = z.object({
  id: z.string(),
  date: z.string().nullable().optional(),
  transactionType: z.string().default(""),
  category: z.string().default(""),
  description: z.string().default(""),
  charges: num,
  credits: num,
  balance: num,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

const LedgerResponseSchema = z.object({
  data: z.object({ entries: z.array(LedgerEntrySchema) }),
});

/** One lease's ledger drill-in, newest first, capped at 500 by the server. */
export async function fetchLeaseLedger(config: StaffConfig, leaseId: string): Promise<LedgerEntry[]> {
  const json = await apiJson(
    `/api/resman/manager/ledger?leaseId=${encodeURIComponent(leaseId)}`,
    config,
  );
  return LedgerResponseSchema.parse(json).data.entries;
}

// ---- manager leases (thin read for agent scorecards) -----------------------

export const ManagerLeaseSchema = z.object({
  id: z.string(),
  unitId: z.string().nullable().optional(),
  unitNumber: z.string().default(""),
  status: z.string().default(""),
  approvalStatus: z.string().default(""),
  approvedDate: z.string().nullable().optional(),
  applicationDate: z.string().nullable().optional(),
  signedDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  originalStartDate: z.string().nullable().optional(),
  startDateChanges: z.number().optional(),
  leaseSentDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  moveInDate: z.string().nullable().optional(),
  moveOutDate: z.string().nullable().optional(),
  leasingAgent: z.string().default(""),
  marketRent: num,
  residentRent: num,
  balance: num,
  /** Activity-Log-sourced deposit; null is UNKNOWN, never zero. See leases.ts. */
  depositAmount: num,
  depositLoggedDate: z.string().nullable().optional(),
  leaseVoidedDate: z.string().nullable().optional(),
  isCurrentLease: z.boolean().default(false),
  isMostRecentLease: z.boolean().default(false),
});
export type ManagerLease = z.infer<typeof ManagerLeaseSchema>;

const LeasesResponseSchema = z.object({
  data: z.object({ leases: z.array(ManagerLeaseSchema) }),
});

/** The 24-month lease window (plus anything still current). */
export async function fetchManagerLeases(config: StaffConfig): Promise<ManagerLease[]> {
  const json = await apiJson("/api/resman/manager/leases", config);
  return LeasesResponseSchema.parse(json).data.leases;
}

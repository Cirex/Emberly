import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The shared staff notes thread on a lease — the pipeline detail sheet's
 * conversation. GET is scoped to one lease (threads load on sheet open, not on
 * the sync tick); POST attribution happens server-side from the token.
 */

export const LeaseNoteSchema = z.object({
  id: z.string(),
  resmanLeaseId: z.string(),
  unitNumber: z.string().default(""),
  body: z.string(),
  createdBy: z.string().default(""),
  createdByRole: z.string().default(""),
  createdAt: z.string().nullable(),
});
export type LeaseNote = z.infer<typeof LeaseNoteSchema>;

const ListSchema = z.object({ data: z.array(LeaseNoteSchema) });
const CreateResponseSchema = z.object({ data: LeaseNoteSchema });

/** The lease's thread, oldest first (the server orders it). */
export async function fetchLeaseNotes(config: StaffConfig, leaseId: string): Promise<LeaseNote[]> {
  const res = await apiJson(
    `/api/resman/manager/lease-notes?lease=${encodeURIComponent(leaseId)}`,
    config,
  );
  return ListSchema.parse(res).data;
}

export async function createLeaseNote(
  config: StaffConfig,
  input: { resmanLeaseId: string; unitNumber?: string; body: string },
): Promise<LeaseNote> {
  const res = await apiJson(`/api/resman/manager/lease-notes`, config, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return CreateResponseSchema.parse(res).data;
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffToken } from "@/lib/resman-api-auth";
import {
  createDelinquencyAction,
  DELINQUENCY_ACTION_KINDS,
  delinquencyActionActor,
  PROMISE_DATED_KINDS,
} from "@/lib/delinquency-actions";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * POST /api/resman/manager/delinquency-actions — record one collections
 * touchpoint (call, notice, promise, filing, …) against a lease. Attribution
 * comes from the token (label + admin id), like work-order photos. The lease
 * id is a soft reference — the record must survive the sync deleting the
 * lease — so no existence check is made. Staff-token only.
 */

const NUMERIC_12_2_MAX = 9_999_999_999.99;

const CreateSchema = z
  .object({
    resmanLeaseId: z.string().trim().min(1).max(120),
    resmanUnitId: z.string().trim().max(120).optional(),
    unitNumber: z.string().trim().max(60).optional(),
    kind: z.enum(DELINQUENCY_ACTION_KINDS),
    note: z.string().trim().max(4000).optional(),
    amount: z.number().finite().min(0).max(NUMERIC_12_2_MAX).optional(),
    promiseDueDate: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
      .optional(),
  })
  .refine((value) => value.promiseDueDate === undefined || PROMISE_DATED_KINDS.has(value.kind), {
    message: "promiseDueDate is only valid for promise_recorded / payment_plan",
  });

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:delinquency");
  if (!auth.ok) return auth.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const action = await createDelinquencyAction(client, parsed.data, delinquencyActionActor(auth));
    return NextResponse.json({ data: action }, { status: 201 });
  } catch (error) {
    console.error("[resman-api manager/delinquency-actions] Create error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

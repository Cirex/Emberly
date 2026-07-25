import { NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffToken } from "@/lib/resman-api-auth";
import {
  createInsuranceAction,
  INSURANCE_ACTION_KINDS,
  insuranceActionActor,
} from "@/lib/manager-insurance";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * POST /api/resman/manager/insurance-actions — record one insurance
 * follow-up (proof requested, second notice, manual verification, note)
 * against a lease. Attribution comes from the token (label + admin id),
 * exactly like delinquency-actions. The lease id is a soft reference — the
 * record must survive the sync deleting the lease — so no existence check is
 * made. Staff-token only.
 */

const CreateSchema = z.object({
  resmanLeaseId: z.string().trim().min(1).max(120),
  unitNumber: z.string().trim().max(60).optional(),
  kind: z.enum(INSURANCE_ACTION_KINDS),
  note: z.string().trim().max(4000).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:insurance");
  if (!auth.ok) return auth.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const action = await createInsuranceAction(client, parsed.data, insuranceActionActor(auth));
    return NextResponse.json({ data: action }, { status: 201 });
  } catch (error) {
    console.error("[resman-api manager/insurance-actions] Create error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

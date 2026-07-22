import { NextResponse } from "next/server";
import { z } from "zod";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import {
  createRenewalOffer,
  listRenewalOffers,
  renewalOfferActor,
} from "@/lib/renewal-offers";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/resman/manager/renewal-offers — every live (non-deleted) offer,
 * newest first; the phone joins them with the lease mirror into the Renewals
 * board on device.
 * POST /api/resman/manager/renewal-offers — record one sent renewal offer
 * against a lease. Attribution comes from the token (label + admin id),
 * exactly like delinquency-actions. The lease id is a soft reference — the
 * record must survive the sync deleting the lease — so no existence check is
 * made. Staff-token only.
 */

const NUMERIC_12_2_MAX = 9_999_999_999.99;

const CreateSchema = z
  .object({
    resmanLeaseId: z.string().trim().min(1).max(120),
    resmanUnitId: z.string().trim().max(120).optional(),
    unitNumber: z.string().trim().max(60).optional(),
    priorRent: z.number().finite().min(0).max(NUMERIC_12_2_MAX).optional(),
    proposedRent: z.number().finite().min(0).max(NUMERIC_12_2_MAX),
    termMonths: z.number().int().min(1).max(60).optional(),
    isMonthToMonth: z.boolean().optional(),
    note: z.string().trim().max(4000).optional(),
  })
  .refine((value) => !(value.isMonthToMonth === true && value.termMonths !== undefined), {
    message: "A month-to-month offer carries no termMonths",
  });

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const client = createUntypedAdminClient();
    const offers = await listRenewalOffers(client);
    return NextResponse.json({ data: { offers } });
  } catch (error) {
    console.error("[resman-api manager/renewal-offers] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const offer = await createRenewalOffer(client, parsed.data, renewalOfferActor(auth));
    return NextResponse.json({ data: offer }, { status: 201 });
  } catch (error) {
    console.error("[resman-api manager/renewal-offers] Create error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

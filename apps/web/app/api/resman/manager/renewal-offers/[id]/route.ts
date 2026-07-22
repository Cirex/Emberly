import { NextResponse } from "next/server";
import { z } from "zod";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { RENEWAL_RESOLUTION_STATUSES, resolveRenewalOffer } from "@/lib/renewal-offers";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * PATCH /api/resman/manager/renewal-offers/[id] — record the tenant's
 * response (accepted / declined) or withdraw the offer, stamping
 * responded_at. 404 for unknown or soft-deleted ids; 400 once an offer has
 * already resolved — a response is recorded once, never rewritten (send a new
 * offer instead). Staff-token only.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ResolveSchema = z.object({
  status: z.enum(RENEWAL_RESOLUTION_STATUSES),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = ResolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const { id } = await params;
    // A malformed uuid would error at the database; answer the same 404 an
    // unknown id gets without touching it.
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 });
    }
    const client = createUntypedAdminClient();
    const result = await resolveRenewalOffer(client, id, parsed.data.status);
    if (result.outcome === "not_found") {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 });
    }
    if (result.outcome === "already_resolved") {
      return NextResponse.json({ error: "Offer already resolved" }, { status: 400 });
    }
    return NextResponse.json({ data: result.offer });
  } catch (error) {
    console.error("[resman-api manager/renewal-offers] Resolve error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

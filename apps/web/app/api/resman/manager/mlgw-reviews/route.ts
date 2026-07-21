import { NextResponse } from "next/server";
import { z } from "zod";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { setMlgwReviewed } from "@/lib/manager-mlgw";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * POST /api/resman/manager/mlgw-reviews — toggle one exception's reviewed
 * checkbox. reviewed=true upserts the checklist row under the sync's natural
 * key (`propertyId|billId|exceptionKind`, property resolved from the bill —
 * 404 when the bill is unknown); reviewed=false clears it. Staff-token only.
 */

const ReviewSchema = z.object({
  billId: z.string().trim().min(1).max(200),
  accountNumber: z.string().trim().max(60).optional(),
  exceptionKind: z.string().trim().min(1).max(120),
  reviewed: z.boolean(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = ReviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const result = await setMlgwReviewed(client, parsed.data);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ data: { reviewed: result.reviewed } });
  } catch (error) {
    console.error("[resman-api manager/mlgw-reviews] Update error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

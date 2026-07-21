import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { setMlgwReviewed } from "@/lib/manager-mlgw";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * POST /api/admin/utilities/reviews — the admin portal's "Mark as Reviewed"
 * toggle on a utility exception. Same checklist rows the manager app writes
 * (mlgw_exception_reviews via setMlgwReviewed), so a review on the desk
 * clears the phone's list and vice versa. Admin session only; viewers are
 * read-only.
 */

const ReviewSchema = z.object({
  billId: z.string().trim().min(1).max(200),
  accountNumber: z.string().trim().max(60).optional(),
  exceptionKind: z.string().trim().min(1).max(120),
  reviewed: z.boolean(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireAdmin(request, {
    roles: ["super_admin", "property_manager", "security_manager"],
  });
  if (!auth.ok) return auth.response;

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
    return NextResponse.json({ ok: true, reviewed: result.reviewed });
  } catch (error) {
    console.error("[admin/utilities/reviews POST] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

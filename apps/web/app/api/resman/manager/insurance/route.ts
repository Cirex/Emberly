import { NextResponse } from "next/server";
import { requireStaffToken } from "@/lib/resman-api-auth";
import { listInsuranceActions, listInsurancePolicies } from "@/lib/manager-insurance";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/insurance — the insurance-compliance board feed:
 * one policy row per CURRENT lease (best policy by latest end_date; all-null
 * policy fields = never filed), plus the Emberly follow-up trail (proof
 * requests, second notices, verifications), newest first. The phone derives
 * covered/expiring/lapsed from the end dates on device — compliance is a date
 * comparison, not a server verdict. Policy numbers are masked server-side to
 * their last four characters. Staff-token only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:insurance");
  if (!auth.ok) return auth.response;

  try {
    const client = createUntypedAdminClient();
    const [policies, actions] = await Promise.all([
      listInsurancePolicies(client),
      listInsuranceActions(client),
    ]);
    return NextResponse.json({ data: { policies, actions } });
  } catch (error) {
    console.error("[resman-api manager/insurance] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

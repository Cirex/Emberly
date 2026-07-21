import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { getManagerMlgw } from "@/lib/manager-mlgw";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/mlgw — the utility surface in one chunky payload:
 * accounts with current dues, each account's current bill with charge totals,
 * a 12-month spend series aggregated by bill month, and the exception-review
 * checklist state. Staff-token only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const client = createUntypedAdminClient();
    const payload = await getManagerMlgw(client);
    return NextResponse.json({ data: payload });
  } catch (error) {
    console.error("[resman-api manager/mlgw] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

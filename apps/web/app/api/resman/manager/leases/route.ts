import { NextResponse } from "next/server";
import { requireStaffToken } from "@/lib/resman-api-auth";
import { listManagerLeases } from "@/lib/manager-leases";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/leases — leases from the last 24 months (by
 * application, start, or move-in date) plus anything still current, in one
 * chunky payload. The manager app derives Pipeline / Expirations / Forecast
 * boards and agent scorecards on device. Staff-token only: scanners are gate
 * devices and the leasing pipeline is none of their business.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:leases");
  if (!auth.ok) return auth.response;

  try {
    const client = createUntypedAdminClient();
    const leases = await listManagerLeases(client);
    return NextResponse.json({ data: { leases } });
  } catch (error) {
    console.error("[resman-api manager/leases] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

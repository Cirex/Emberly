import { NextResponse } from "next/server";
import { listOwnerReports } from "@/lib/manager-reports";
import { requireStaffToken } from "@/lib/resman-api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/reports — the owner-report archive index for the
 * manager app: `{ data: { reports: [{ period, generatedAt, summary }] } }`,
 * newest first, capped at 24. Each summary is parsed server-side from the
 * period's frozen-figures JSON so the phone's report card and PAST REPORTS
 * band render without any extra fetches. Staff-token only — scanners are gate
 * devices and the owner packet is none of their business (same rule as
 * /manager/snapshots).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:reports");
  if (!auth.ok) return auth.response;

  try {
    const reports = await listOwnerReports();
    return NextResponse.json({ data: { reports } });
  } catch (error) {
    console.error("[resman-api manager/reports] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

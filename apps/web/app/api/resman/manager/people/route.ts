import { NextResponse } from "next/server";
import { requireStaffToken } from "@/lib/resman-api-auth";
import { listPeopleIndex } from "@/lib/manager-people";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/people — the SEARCH INDEX: one lightweight row per
 * resident (name, unit, phones, email, plates) so the manager app can match
 * name / unit / phone / plate entirely on device, offline, from cache.
 *
 * PII-FREE BY CONSTRUCTION: birthdate, driver's licence and income are not in
 * this payload and never will be — it is persisted to the phone's disk. The
 * profile route is the only place those fields can be requested, and only
 * behind `?includePii=1` with an audit-log row.
 *
 * Staff-token only: scanners are gate devices, and scoped field-device roles
 * (maintenance, security) have no business holding the resident roster.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:people");
  if (!auth.ok) return auth.response;

  try {
    const client = createUntypedAdminClient();
    const people = await listPeopleIndex(client);
    return NextResponse.json({ data: { people } });
  } catch (error) {
    console.error("[resman-api manager/people] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

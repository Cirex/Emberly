import { NextResponse } from "next/server";
import { requireStaffToken } from "@/lib/resman-api-auth";
import {
  getPersonProfile,
  peopleAuditActor,
  recordPeoplePiiAccess,
  wantsPii,
} from "@/lib/manager-people";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/resman/manager/people/[id] — the full tenant profile for one
 * `resman_person_lease_id`: the resident, their lease facts, household,
 * vehicles, insurance, employment, emergency contacts, addresses, and the
 * unit's ten most recent work orders.
 *
 * PII GATING (the design's build note, enforced): birthdate, driversLicense,
 * driversLicenseState, monthlyIncome and otherIncome are ABSENT from the
 * default payload. `?includePii=1` returns them and writes an admin_audit_logs
 * row recording who asked, for whom, and which field — `?field=birthdate`
 * names the field the manager tapped. The derived `rentToIncomeRatio` is in
 * every response: it is the affordability answer without the salary.
 *
 * Staff-token only.
 */
export async function GET(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:people");
  if (!auth.ok) return auth.response;

  try {
    const { id } = await params;
    const personLeaseId = id.trim();
    if (personLeaseId === "") {
      return NextResponse.json({ error: "Person not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const includePii = wantsPii(url.searchParams);
    const client = createUntypedAdminClient();
    const profile = await getPersonProfile(client, personLeaseId, includePii);
    if (!profile) {
      return NextResponse.json({ error: "Person not found" }, { status: 404 });
    }

    // Logged AFTER the read succeeds, so a 404 probe cannot write audit noise;
    // never blocks the response (recordPeoplePiiAccess swallows its errors).
    if (includePii) {
      await recordPeoplePiiAccess(client, peopleAuditActor(auth), {
        personLeaseId,
        field: url.searchParams.get("field")?.trim() || undefined,
        leaseId: profile.lease?.leaseId,
        unitNumber: profile.lease?.unitNumber,
      });
    }

    return NextResponse.json({ data: { profile } });
  } catch (error) {
    console.error("[resman-api manager/people] Profile error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

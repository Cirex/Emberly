import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { listDelinquencyActionsForUnits } from "@/lib/delinquency-actions";
import { listDelinquentUnits } from "@/lib/manager-delinquency";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/delinquency — the delinquency board feed: units
 * that owe money or carry a delinquency note, plus the live action timeline
 * (calls, notices, promises, filings) for those units, newest first. The
 * phone stitches both into the board. Staff-token only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const client = createUntypedAdminClient();
    const units = await listDelinquentUnits(client);
    const actions = await listDelinquencyActionsForUnits(
      client,
      units.map((unit) => unit.unitId),
    );
    return NextResponse.json({ data: { units, actions } });
  } catch (error) {
    console.error("[resman-api manager/delinquency] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

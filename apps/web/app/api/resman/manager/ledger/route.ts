import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { listLeaseLedger } from "@/lib/manager-ledger";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/ledger?leaseId=… — one lease's transactions from
 * the resman_transactions mirror, newest first, capped at 500. The drill-in
 * behind a ledger-summary row. Staff-token only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const leaseId = new URL(request.url).searchParams.get("leaseId")?.trim() ?? "";
  if (leaseId === "") {
    return NextResponse.json({ error: "Missing leaseId" }, { status: 400 });
  }

  try {
    const client = createUntypedAdminClient();
    const entries = await listLeaseLedger(client, leaseId);
    return NextResponse.json({ data: { entries } });
  } catch (error) {
    console.error("[resman-api manager/ledger] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

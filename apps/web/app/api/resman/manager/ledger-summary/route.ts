import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { fetchLedgerSummaryEntries, summarizeLedgerEntries } from "@/lib/manager-ledger";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/ledger-summary — one row per lease aggregated from
 * the resman_transactions mirror: billed/collected totals, last payment date,
 * first late month (month-end running balance heuristic), and net
 * concession/write-off values. No raw-SQL RPC exists, so the aggregation runs
 * in JS over a paged, column-slim select capped at 50k rows. Staff-token only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const client = createUntypedAdminClient();
    const entries = await fetchLedgerSummaryEntries(client);
    const leases = summarizeLedgerEntries(entries);
    return NextResponse.json({ data: { leases } });
  } catch (error) {
    console.error("[resman-api manager/ledger-summary] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

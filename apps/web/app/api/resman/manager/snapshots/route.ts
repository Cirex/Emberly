import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { clampSnapshotMonths, listManagerSnapshots } from "@/lib/manager-snapshots";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/snapshots?months=12 — the daily property_snapshots
 * window (default 12 months, capped at 24), oldest first, for the manager
 * app's Trends charts. The phone renders the series directly; nulls mean the
 * series hadn't begun yet (the honest-backfill rule). Staff-token only:
 * scanners are gate devices and property KPIs are none of their business.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const months = clampSnapshotMonths(new URL(request.url).searchParams.get("months"));
    const client = createUntypedAdminClient();
    const snapshots = await listManagerSnapshots(client, months);
    return NextResponse.json({ data: { snapshots } });
  } catch (error) {
    console.error("[resman-api manager/snapshots] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { listPmTaskGroups } from "@/lib/pm-tasks";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Preventive-maintenance tasks for the maintenance app.
 *
 *   GET /api/resman/pm-tasks?round=current   (default)
 *   GET /api/resman/pm-tasks?round=YYYY-MM
 *
 * Active templates' tasks for the requested round, grouped by template. The
 * "current" round is per-template (cadence/anchor math shared with the admin
 * overview and the nightly generator). Staff-token only: scanners are gate
 * devices and PM rounds are none of their business.
 */

const ROUND_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const roundParam = new URL(request.url).searchParams.get("round") ?? "current";
  if (roundParam !== "current" && !ROUND_RE.test(roundParam)) {
    return NextResponse.json({ error: "Invalid round" }, { status: 400 });
  }
  const round = roundParam === "current" ? null : roundParam;

  try {
    const client = createUntypedAdminClient();
    const templates = await listPmTaskGroups(client, round);
    return NextResponse.json({ data: { templates } });
  } catch (error) {
    console.error("[resman-api pm-tasks] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

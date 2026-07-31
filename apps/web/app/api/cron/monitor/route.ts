import { NextRequest, NextResponse } from "next/server";
import { secureCompare, verifyAdminKey } from "@/lib/auth";
import { runMonitor } from "@/lib/monitor";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

/**
 * The scheduled monitor — run this nightly, after the sync pipeline.
 *
 * Runs the anomaly watches and the freshness check and writes what it finds to
 * monitor_findings. This is the push half of the MCP's pull tools: both existed
 * and neither was ever going to be run by hand every day.
 *
 * Read-only against the mirror; the only writes are findings.
 */

// node:crypto (secureCompare) + the service-role client require Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The anomaly watches scan several series; give them room.
export const maxDuration = 300;

/** The scheduler credential: a bearer matching CRON_SECRET. */
function hasCronBearer(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;
  const authHeader = request.headers.get("authorization") ?? "";
  return authHeader.startsWith("Bearer ") && secureCompare(authHeader.slice(7), cronSecret);
}

async function run(): Promise<NextResponse> {
  try {
    const result = await runMonitor(createUntypedAdminClient());
    // Never log the findings themselves: an anomaly summary carries a service
    // address, which is resident-identifying. Counts are enough for a log line.
    console.info(
      `[cron/monitor] ${result.findings.length} finding(s): ` +
        `${result.opened} opened, ${result.updated} updated, ${result.resolved} resolved`,
    );
    return NextResponse.json({
      ok: true,
      opened: result.opened,
      updated: result.updated,
      resolved: result.resolved,
      total: result.findings.length,
      notes: result.notes,
    });
  } catch (error) {
    console.error("[cron/monitor] failed:", error);
    return NextResponse.json({ error: "Monitor failed" }, { status: 500 });
  }
}

/**
 * POST: the manual admin trigger (session cookie / x-admin-key) or the
 * scheduler bearer. A SameSite=Lax cookie is not attached to a cross-site POST,
 * so the cookie path is not CSRF-exploitable.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasCronBearer(request) && !(await verifyAdminKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

/**
 * GET: scheduler bearer only. No admin-cookie fallback — a Lax cookie rides a
 * top-level GET, so accepting it here would let a page trigger this write via
 * CSRF. Same reasoning as /api/cron/cleanup.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!hasCronBearer(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

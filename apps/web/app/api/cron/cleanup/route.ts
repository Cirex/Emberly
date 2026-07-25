import { NextRequest, NextResponse } from "next/server";
import { secureCompare, verifyAdminKey } from "@/lib/auth";
import { runAppDataCleanup } from "@/lib/cleanup";
import { createAdminClient } from "@/lib/supabase/admin";

/** The scheduler credential: a bearer that matches CRON_SECRET. Never sent by a
 *  browser, so it is safe on any method. Absent CRON_SECRET, there is no
 *  scheduler auth (the fallback is the admin session, POST-only — see below). */
function hasCronBearer(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;
  const authHeader = request.headers.get("authorization") ?? "";
  return authHeader.startsWith("Bearer ") && secureCompare(authHeader.slice(7), cronSecret);
}

async function runCleanup(): Promise<NextResponse> {
  try {
    const result = await runAppDataCleanup(createAdminClient());
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[cron/cleanup] Cleanup failed:", error);
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
}

/**
 * POST: the manual admin trigger (admin session cookie / x-admin-key) or the
 * scheduler bearer. A SameSite=Lax session cookie is NOT attached to a
 * cross-site POST, so the admin-cookie path is not CSRF-exploitable here.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // `verifyAdminKey` is async — un-awaited it returns a Promise, which is
  // always truthy, so the negation was always false and this 401 was
  // unreachable. The endpoint was open to anyone.
  if (!hasCronBearer(request) && !(await verifyAdminKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCleanup();
}

/**
 * GET: scheduler only (bearer). Deliberately NO admin-cookie fallback — a Lax
 * session cookie rides a top-level GET navigation, so allowing the cookie here
 * would let a malicious page trigger this destructive cleanup via CSRF.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!hasCronBearer(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCleanup();
}

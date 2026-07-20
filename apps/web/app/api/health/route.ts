import { NextResponse } from "next/server";

/**
 * Lightweight liveness endpoint for Coolify (and any other) health monitoring.
 *
 * Intentionally has no database or external dependency so it stays fast and
 * cannot be taken down by a slow/misconfigured downstream. Returns 200 as long
 * as the Next.js server process is up and serving requests.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "emberly-web",
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}

/**
 * GET /api/auth/verify
 *
 * Lightweight Emberly token check. ResMan session heartbeats use
 * POST /api/auth/resman-heartbeat so raw ResMan session material is supplied
 * only by the mobile client and never embedded in the Emberly token.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyRequest } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const payload = verifyRequest(request);

  // App token itself is missing or expired
  if (!payload) {
    return NextResponse.json({ valid: false, reason: "token_invalid" });
  }

  return NextResponse.json({ valid: true });
}

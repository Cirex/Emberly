import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyRequest, verifySignedResmanPortalSession } from "@/lib/auth";
import { isAllowedResmanPortalSession, verifyResmanPortalAccess } from "@/lib/resman-portal";
import {
  buildResidentAccessUpdate,
  getResidentHeartbeatNextCheckAfter,
  validateResmanHeartbeatAccess,
} from "@/lib/residents";
import { createAdminClient } from "@/lib/supabase/admin";

const ResmanCookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string().min(1),
  secure: z.boolean(),
  httpOnly: z.boolean(),
});

const HeartbeatSchema = z.object({
    resmanSession: z.object({
      baseUrl: z.string().url(),
      signInUrl: z.string().url(),
      cookieHeader: z.string().min(1),
      cookies: z.array(ResmanCookieSchema),
      issuedAt: z.string().min(1),
      signature: z.string().min(1),
    }),
  });

export async function POST(request: NextRequest) {
  const payload = verifyRequest(request);
  if (!payload) {
    return NextResponse.json({ valid: false, reason: "token_invalid" }, { status: 401 });
  }

  const parsed = HeartbeatSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ valid: false, reason: "invalid_request" }, { status: 400 });
  }

  const resmanSession = verifySignedResmanPortalSession(parsed.data.resmanSession);
  if (!resmanSession) {
    return NextResponse.json(
      { valid: false, reason: "resman_session_tampered" },
      { status: 401 }
    );
  }

  if (!isAllowedResmanPortalSession(resmanSession)) {
    return NextResponse.json(
      { valid: false, reason: "resman_origin_not_allowed" },
      { status: 403 }
    );
  }

  const portalAccess = await verifyResmanPortalAccess(resmanSession);
  const validation = validateResmanHeartbeatAccess({
    tokenLedgerId: payload.ledgerId,
    portalAccess,
  });

  const verifiedAt = new Date();
  const accessUpdate = buildResidentAccessUpdate(validation, portalAccess, verifiedAt.toISOString());
  if (payload.residentId && accessUpdate) {
    const { error } = await createAdminClient()
      .from("residents")
      .update(accessUpdate)
      .eq("id", payload.residentId);

    if (error) {
      console.error("[auth/resman-heartbeat] Failed to update access status:", error);
    }
  }

  if (!validation.valid) {
    return NextResponse.json(
      {
        valid: false,
        reason: validation.reason,
        resmanStatus: portalAccess.status ?? null,
      },
      { status: validation.status }
    );
  }

	  return NextResponse.json({
	    valid: true,
	    resmanAccess: portalAccess,
	    nextCheckAfter: getResidentHeartbeatNextCheckAfter(verifiedAt.getTime()),
	  });
	}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJson, requestSource } from "@/lib/http";
import { buildAccessAuditInsert, buildAccessRequestInsert } from "@/lib/map-sync-access";
import { createClaimToken, MAP_ANNOTATIONS_FEATURE_KEY } from "@/lib/map-sync";
import { checkRateLimit } from "@/lib/rate-limit";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

const AccessRequestSchema = z.object({
  resmanAccountId: z.string().trim().min(1),
  propertyId: z.string().trim().min(1),
  propertyName: z.string().trim().min(1),
  featureKey: z.literal(MAP_ANNOTATIONS_FEATURE_KEY).optional(),
  requesterDisplayName: z.string().trim().min(1).optional().nullable(),
  requesterResmanLogin: z.string().trim().min(1).optional().nullable(),
  deviceId: z.string().trim().min(1),
});

export async function POST(request: NextRequest) {
  const body = await readJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const parsed = AccessRequestSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const source = requestSource(request);
    const sourceAllowed = await checkRateLimit({
      bucket: `map-access-request:${source}`,
      maxAttempts: 30,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });
    if (!sourceAllowed) {
      return NextResponse.json({ error: "Too many map data access attempts" }, { status: 429 });
    }

    const featureKey = parsed.data.featureKey ?? MAP_ANNOTATIONS_FEATURE_KEY;
    const scopeAllowed = await checkRateLimit({
      bucket: `map-access-request:${source}:${parsed.data.resmanAccountId}:${parsed.data.propertyId}:${featureKey}:${parsed.data.deviceId}`,
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,
      failClosed: true,
    });
    if (!scopeAllowed) {
      return NextResponse.json({ error: "Too many map data access attempts" }, { status: 429 });
    }

    const claimToken = createClaimToken();
    const supabase = createUntypedAdminClient();
    const { data: existingKey, error: existingKeyError } = await supabase
      .from("map_sync_keys")
      .select("id")
      .eq("resman_account_id", parsed.data.resmanAccountId)
      .eq("property_id", parsed.data.propertyId)
      .eq("feature_key", featureKey)
      .eq("device_id", parsed.data.deviceId)
      .eq("active", true)
      .maybeSingle();

    if (existingKeyError) {
      console.error("[map/access-requests POST] Existing key lookup error:", existingKeyError);
      return NextResponse.json({ error: "Failed to verify existing sync key" }, { status: 500 });
    }
    if (existingKey) {
      return NextResponse.json(
        { error: "An active sync key already exists for this request scope", reason: "active_key_exists" },
        { status: 409 },
      );
    }

    const { data: insertedRequest, error: insertError } = await supabase
      .from("map_sync_access_requests")
      .insert(buildAccessRequestInsert({ ...parsed.data, claimToken }))
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, requester_resman_login_hash, device_id, status")
      .single();

    if (insertError || !insertedRequest) {
      if (insertError?.code === "23505") {
        return NextResponse.json(
          { error: "An active access request already exists for this device", reason: "active_request_exists" },
          { status: 409 },
        );
      }
      console.error("[map/access-requests POST] Insert error:", insertError);
      return NextResponse.json({ error: "Failed to create access request" }, { status: 500 });
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAccessAuditInsert("access.request", insertedRequest, null));

    if (auditError) {
      console.error("[map/access-requests POST] Audit error:", auditError);
    }

    return NextResponse.json({
      requestId: insertedRequest.id,
      status: insertedRequest.status,
      claimToken,
    });
  } catch (error) {
    console.error("[map/access-requests POST] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

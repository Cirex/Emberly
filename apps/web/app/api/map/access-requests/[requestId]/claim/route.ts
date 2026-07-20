import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJson, requestSource } from "@/lib/http";
import {
  buildAccessAuditInsert,
  buildClaimedRequestPatch,
  buildSyncKeyInsert,
} from "@/lib/map-sync-access";
import { createSyncKeySecret, verifySecretHash } from "@/lib/map-sync";
import { checkRateLimit } from "@/lib/rate-limit";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ requestId: string }>;
}

const ClaimSchema = z.object({
  deviceId: z.string().trim().min(1),
  claimToken: z.string().trim().min(1),
});

export async function POST(request: NextRequest, { params }: RouteContext) {
  const body = await readJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const parsed = ClaimSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { requestId } = await params;
    const source = requestSource(request);
    const sourceAllowed = await checkRateLimit({
      bucket: `map-access-claim:${source}`,
      maxAttempts: 60,
      windowMs: 15 * 60 * 1000,
      failClosed: true,
    });
    if (!sourceAllowed) {
      return NextResponse.json({ error: "Too many map sync claim attempts" }, { status: 429 });
    }

    const requestAllowed = await checkRateLimit({
      bucket: `map-access-claim:${source}:${requestId}:${parsed.data.deviceId}`,
      maxAttempts: 10,
      windowMs: 15 * 60 * 1000,
      failClosed: true,
    });
    if (!requestAllowed) {
      return NextResponse.json({ error: "Too many map sync claim attempts" }, { status: 429 });
    }

    const supabase = createUntypedAdminClient();
    const { data: accessRequest, error: loadError } = await supabase
      .from("map_sync_access_requests")
      .select("id, resman_account_id, property_id, property_name, feature_key, requester_display_name, requester_resman_login_hash, device_id, status, claim_token_hash")
      .eq("id", requestId)
      .maybeSingle();

    if (loadError) {
      console.error("[map/access-requests claim] Load error:", loadError);
      return NextResponse.json({ error: "Failed to load access request" }, { status: 500 });
    }
    if (!accessRequest) {
      return NextResponse.json({ error: "Access request not found" }, { status: 404 });
    }
    if (accessRequest.device_id !== parsed.data.deviceId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!verifySecretHash(parsed.data.claimToken, accessRequest.claim_token_hash)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (accessRequest.status !== "approved") {
      return NextResponse.json(
        { error: "Access request is not approved", status: accessRequest.status },
        { status: 409 },
      );
    }

    const { data: existingKey, error: existingKeyError } = await supabase
      .from("map_sync_keys")
      .select("id")
      .eq("resman_account_id", accessRequest.resman_account_id)
      .eq("property_id", accessRequest.property_id)
      .eq("feature_key", accessRequest.feature_key)
      .eq("device_id", accessRequest.device_id)
      .eq("active", true)
      .maybeSingle();

    if (existingKeyError) {
      console.error("[map/access-requests claim] Existing key lookup error:", existingKeyError);
      return NextResponse.json({ error: "Failed to verify existing sync key" }, { status: 500 });
    }
    if (existingKey) {
      return NextResponse.json(
        { error: "An active sync key already exists for this request scope", reason: "active_key_exists" },
        { status: 409 },
      );
    }

    const claimedAt = new Date().toISOString();
    const { data: claimedRequest, error: claimError } = await supabase
      .from("map_sync_access_requests")
      .update(buildClaimedRequestPatch(claimedAt))
      .eq("id", requestId)
      .eq("status", "approved")
      .select("id")
      .maybeSingle();

    if (claimError || !claimedRequest) {
      console.error("[map/access-requests claim] Claim update error:", claimError, {
        requestId,
        resmanAccountId: accessRequest.resman_account_id,
        propertyId: accessRequest.property_id,
        featureKey: accessRequest.feature_key,
        deviceId: accessRequest.device_id,
      });
      return NextResponse.json({ error: "Failed to mark access request claimed" }, { status: 409 });
    }

    const syncKey = createSyncKeySecret();
    const { data: insertedKey, error: keyInsertError } = await supabase
      .from("map_sync_keys")
      .insert(buildSyncKeyInsert(accessRequest, syncKey))
      .select("id, resman_account_id, property_id, property_name, feature_key, capabilities, requester_display_name, device_id, active, created_at")
      .single();

    if (keyInsertError || !insertedKey) {
      console.error("[map/access-requests claim] Key insert after claim failed:", keyInsertError, {
        requestId,
        resmanAccountId: accessRequest.resman_account_id,
        propertyId: accessRequest.property_id,
        featureKey: accessRequest.feature_key,
        deviceId: accessRequest.device_id,
      });
      const { error: rollbackError } = await supabase
        .from("map_sync_access_requests")
        .update({ status: "approved", updated_at: new Date().toISOString() })
        .eq("id", requestId)
        .eq("status", "claimed");

      if (rollbackError) {
        console.error("[map/access-requests claim] Claim rollback after key insert failed:", rollbackError, {
          requestId,
          resmanAccountId: accessRequest.resman_account_id,
          propertyId: accessRequest.property_id,
          featureKey: accessRequest.feature_key,
          deviceId: accessRequest.device_id,
        });
      }
      return NextResponse.json({ error: "Failed to create sync key" }, { status: 500 });
    }

    const { error: auditError } = await supabase
      .from("map_annotation_audit_logs")
      .insert(buildAccessAuditInsert("access.claim", accessRequest, null, { syncKeyId: insertedKey.id }));

    if (auditError) {
      console.error("[map/access-requests claim] Audit error:", auditError, {
        requestId,
        syncKeyId: insertedKey.id,
      });
    }

    return NextResponse.json({
      syncKey,
      propertyId: insertedKey.property_id,
      featureKey: insertedKey.feature_key,
      capabilities: insertedKey.capabilities,
      key: insertedKey,
    });
  } catch (error) {
    console.error("[map/access-requests claim] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

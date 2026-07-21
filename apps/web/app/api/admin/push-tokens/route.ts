/**
 * Expo push-token registration for the staff apps.
 *   POST   /api/admin/push-tokens — register/refresh a device token
 *   DELETE /api/admin/push-tokens — deactivate a device token (sign-out)
 *
 * The maintenance app calls with its per-user `eapi_` Bearer token, so the
 * row is attributed to the signed-in staff member (requireAdminOrScanner
 * resolves it the same way the map-annotation routes do). The sync worker
 * reads the active rows to send emergency work-order pushes.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { readJson } from "@/lib/http";
import {
  DeletePushTokenSchema,
  RegisterPushTokenSchema,
  deactivatePushToken,
  registerPushToken,
} from "@/lib/push-tokens";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const parsed = RegisterPushTokenSchema.safeParse(body.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await registerPushToken(createUntypedAdminClient(), auth.admin, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[admin/push-tokens POST] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const parsed = DeletePushTokenSchema.safeParse(body.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // Idempotent: deactivating an unknown/inactive token still returns 200.
    await deactivatePushToken(createUntypedAdminClient(), parsed.data.token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[admin/push-tokens DELETE] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

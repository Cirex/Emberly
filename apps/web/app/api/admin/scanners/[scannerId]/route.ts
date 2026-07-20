import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { recordAdminAuditLog } from "@/lib/admin-audit";
import { getScannerDeviceHealth } from "@/lib/admin-operations";
import { createScannerSecret, hashScannerSecret } from "@/lib/scanner-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

const ScannerPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  location: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
});

interface RouteContext {
  params: Promise<{ scannerId: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request, { roles: ["security_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const parsed = ScannerPatchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { scannerId } = await params;
  const { rotateSecret, ...patch } = parsed.data;
  const scannerSecret = rotateSecret ? createScannerSecret() : null;
  const supabase = createUntypedAdminClient();
  const { data, error } = await supabase
    .from("scanner_devices")
    .update({
      ...patch,
      ...(scannerSecret ? {
        secret_hash: hashScannerSecret(scannerSecret),
        secret_rotated_at: new Date().toISOString(),
      } : {}),
    })
    .eq("scanner_id", scannerId)
    .select("id, scanner_id, name, location, enabled, last_seen_at, created_at, updated_at, secret_rotated_at")
    .single();

  if (error || !data) {
    console.error("[admin/scanner PATCH] Update error:", error);
    return NextResponse.json({ error: "Failed to update scanner device" }, { status: 500 });
  }

  await recordAdminAuditLog(supabase, admin, {
    action: scannerSecret ? "scanner.rotate_secret" : "scanner.update",
    targetType: "scanner",
    targetId: scannerId,
    metadata: patch,
  });

  return NextResponse.json({
    scanner: { ...data, health: getScannerDeviceHealth(data) },
    ...(scannerSecret ? { scannerSecret } : {}),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { recordAdminAuditLog } from "@/lib/admin-audit";
import { listAdminScanners } from "@/lib/admin-scanners";
import { getScannerDeviceHealth } from "@/lib/admin-operations";
import { createScannerSecret, hashScannerSecret } from "@/lib/scanner-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

const ScannerSchema = z.object({
  // Optional — when omitted, the id is auto-derived from the name (a stable slug).
  scannerId: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(120),
  location: z.string().max(200).optional().nullable(),
  enabled: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
});

/** URL-safe slug for a scanner name; the auto-assigned scanner_id. */
function slugifyScannerId(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "scanner";
}

/** A slug of `name`, made unique against existing scanner_devices rows. */
async function uniqueScannerId(supabase: UntypedSupabase, name: string): Promise<string> {
  const base = slugifyScannerId(name);
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const { data } = await supabase
      .from("scanner_devices")
      .select("scanner_id")
      .eq("scanner_id", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ scanners: await listAdminScanners() });
  } catch (error) {
    console.error("[admin/scanners GET] Unexpected error:", error);
    return NextResponse.json({ error: "Failed to fetch scanner devices" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request, { roles: ["security_manager"] });
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const parsed = ScannerSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, location, enabled, rotateSecret } = parsed.data;
  const supabase = createUntypedAdminClient();
  const scannerId = parsed.data.scannerId?.trim() || (await uniqueScannerId(supabase, name));
  const { data: existing } = await supabase
    .from("scanner_devices")
    .select("scanner_id, secret_hash")
    .eq("scanner_id", scannerId)
    .maybeSingle();
  const shouldIssueSecret = !existing?.secret_hash || rotateSecret === true;
  const scannerSecret = shouldIssueSecret ? createScannerSecret() : null;
  const { data, error } = await supabase
    .from("scanner_devices")
    .upsert(
      {
        scanner_id: scannerId,
        name,
        location: location ?? null,
        enabled: enabled ?? true,
        ...(scannerSecret ? {
          secret_hash: hashScannerSecret(scannerSecret),
          secret_rotated_at: new Date().toISOString(),
        } : {}),
      },
      { onConflict: "scanner_id" }
    )
    .select("id, scanner_id, name, location, enabled, last_seen_at, created_at, updated_at, secret_rotated_at")
    .single();

  if (error || !data) {
    console.error("[admin/scanners POST] Upsert error:", error);
    return NextResponse.json({ error: "Failed to save scanner device" }, { status: 500 });
  }

  await recordAdminAuditLog(supabase, admin, {
    action: !existing ? "scanner.create" : scannerSecret ? "scanner.rotate_secret" : "scanner.update",
    targetType: "scanner",
    targetId: scannerId,
    metadata: { name, location: location ?? null, enabled: enabled ?? true },
  });

  return NextResponse.json({
    scanner: { ...data, health: getScannerDeviceHealth(data) },
    ...(scannerSecret ? { scannerSecret } : {}),
  });
}

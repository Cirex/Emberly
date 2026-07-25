/**
 * Shared unit tags.
 *   GET  — admins and scanner devices; optional ?unit=<number> filter. Purges
 *          expired tags first, so every reader/sync also cleans up.
 *   POST — admins and scanner devices (guards tag units in the field too).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { readJson } from "@/lib/http";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import { purgeExpiredTags, resolveExpiry, serializeTag, TAG_SELECT, unitContext } from "@/lib/unit-tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  unitNumber: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(48),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .default("#5B7C99"),
  expiryKind: z.enum(["never", "date", "duration", "move_out", "status_change"]).optional().default("never"),
  expiresOn: z.string().trim().optional().nullable(),
  durationDays: z.number().int().positive().max(3650).optional().nullable(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request);
  if (!auth.ok) return auth.response;

  try {
    const client = createUntypedAdminClient();
    await purgeExpiredTags(client);

    const unit = new URL(request.url).searchParams.get("unit")?.trim();
    let query = client.from("unit_tags").select(TAG_SELECT).order("created_at", { ascending: true });
    if (unit) query = query.eq("unit_number", unit);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ tags: (data ?? []).map(serializeTag) });
  } catch (error) {
    console.error("[admin/unit-tags GET] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body.ok) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const parsed = CreateSchema.safeParse(body.body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    const client = createUntypedAdminClient();

    // Conditional rules snapshot the unit's live lease context at creation.
    const ctx =
      parsed.data.expiryKind === "move_out" || parsed.data.expiryKind === "status_change"
        ? await unitContext(client, parsed.data.unitNumber)
        : undefined;
    let resolved;
    try {
      resolved = resolveExpiry(
        {
          kind: parsed.data.expiryKind,
          expiresOn: parsed.data.expiresOn ?? null,
          durationDays: parsed.data.durationDays ?? null,
        },
        ctx,
      );
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Invalid expiration" },
        { status: 400 },
      );
    }

    const isScanner = auth.admin.adminId.startsWith("scanner:");
    const { data, error } = await client
      .from("unit_tags")
      .insert({
        unit_number: parsed.data.unitNumber,
        label: parsed.data.label,
        color_hex: parsed.data.colorHex,
        expiry_kind: parsed.data.expiryKind,
        expires_at: resolved.expires_at,
        bound_lease_id: resolved.bound_lease_id,
        status_trigger: resolved.status_trigger,
        origin: isScanner ? "scanner" : "admin",
        created_by_display_name: auth.admin.displayName,
      })
      .select(TAG_SELECT)
      .single();
    if (error) {
      // Unique (unit_number, lower(label)) violation — the tag already exists.
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ error: "That tag already exists on this unit" }, { status: 409 });
      }
      throw error;
    }
    return NextResponse.json({ tag: serializeTag(data) });
  } catch (error) {
    console.error("[admin/unit-tags POST] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

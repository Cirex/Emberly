/**
 * One unit tag: DELETE removes it. Admins and scanner devices — guards can pull
 * a tag they no longer need, same as they can add one.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ tagId: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = await requireAdminOrScanner(request, { roles: ["property_manager", "security_manager"] });
  if (!auth.ok) return auth.response;

  try {
    const { tagId } = await params;
    const client = createUntypedAdminClient();
    const { data, error } = await client
      .from("unit_tags")
      .delete()
      .eq("id", tagId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[admin/unit-tags DELETE] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

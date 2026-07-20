import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { getAdminStats } from "@/lib/admin-stats";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json(await getAdminStats());
  } catch (err) {
    console.error("[admin/stats] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

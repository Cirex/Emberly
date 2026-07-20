import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { listAdminResidents } from "@/lib/admin-residents";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  try {
    const residents = await listAdminResidents();
    return NextResponse.json({ residents, total: residents.length });
  } catch (err) {
    console.error("[admin/residents GET] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

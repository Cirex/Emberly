import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { getAdminResidentDetail } from "@/lib/admin-resident-detail";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { id: residentId } = await params;

  try {
    const detail = await getAdminResidentDetail(residentId);
    if (!detail) {
      return NextResponse.json({ error: "Resident not found" }, { status: 404 });
    }

    return NextResponse.json(detail);
  } catch (err) {
    console.error("[admin/resident detail] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

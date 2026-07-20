import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { listAdminAlerts } from "@/lib/admin-alerts";

const QuerySchema = z.object({
  status: z.enum(["open", "resolved", "all"]).default("open"),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json({ alerts: await listAdminAlerts(parsed.data.status) });
  } catch (err) {
    console.error("[admin/alerts GET] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

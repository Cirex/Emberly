import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-request";
import { listAdminEntryLogs } from "@/lib/admin-entry-logs";

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().optional(),
  to: z.string().optional(),
  propertyName: z.string().optional(),
  entryType: z.enum(["resident", "guest"]).optional(),
  residentId: z.string().uuid().optional(),
  guestPassId: z.string().uuid().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query parameters", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    return NextResponse.json(await listAdminEntryLogs(parsed.data));
  } catch (err) {
    console.error("[admin/entry-logs] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

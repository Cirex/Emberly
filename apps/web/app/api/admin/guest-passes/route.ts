import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrScanner } from "@/lib/admin-request";
import { normalizeAdminGuestPassSearch } from "@/lib/admin-search";
import { listAdminGuestPasses } from "@/lib/admin-guest-passes";

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(["active", "used", "expired", "revoked"]).optional(),
  search: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdminOrScanner(request);
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

    if (parsed.data.search && !normalizeAdminGuestPassSearch(parsed.data.search)) {
      return NextResponse.json({ error: "Invalid search query" }, { status: 400 });
    }

    return NextResponse.json(await listAdminGuestPasses({ ...parsed.data, requestUrl: request.url }));
  } catch (err) {
    console.error("[admin/guest-passes] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { softDeleteInsuranceAction } from "@/lib/manager-insurance";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * DELETE /api/resman/manager/insurance-actions/[id] — soft delete one
 * follow-up action (sets deleted_at; the row stays for audit). 404 for
 * unknown or already-deleted ids. Staff-token only.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    // A malformed uuid would error at the database; answer the same 404 an
    // unknown id gets without touching it.
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Action not found" }, { status: 404 });
    }
    const client = createUntypedAdminClient();
    const deleted = await softDeleteInsuranceAction(client, id);
    if (!deleted) {
      return NextResponse.json({ error: "Action not found" }, { status: 404 });
    }
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    console.error("[resman-api manager/insurance-actions] Delete error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

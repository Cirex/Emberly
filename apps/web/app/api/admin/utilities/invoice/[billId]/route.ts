import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-request";
import { createAdminClient, createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * GET /api/admin/utilities/invoice/[billId] — Open Invoice: redirect to a
 * short-lived signed URL for the bill's PDF in the mlgw-bills bucket. 404
 * when the bill has no stored file (the sync's file store is a seam; XMS
 * disabled the button in that case and the portal does the same).
 */

const BUCKET = "mlgw-bills";
const SIGNED_URL_TTL_SECONDS = 300;

interface RouteContext {
  params: Promise<{ billId: string }>;
}

export async function GET(request: Request, { params }: RouteContext): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { billId } = await params;
  try {
    const client = createUntypedAdminClient();
    const billRes = await client.from("mlgw_bills").select("id, file_path").eq("id", billId).maybeSingle();
    if (billRes.error) throw new Error(billRes.error.message);
    const filePath = (billRes.data as { file_path?: string } | null)?.file_path?.trim();
    if (!filePath) {
      return NextResponse.json({ error: "No invoice file for this bill" }, { status: 404 });
    }

    // The untyped client's surface omits storage; the typed client carries it.
    const signed = await createAdminClient().storage.from(BUCKET).createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      console.error("[admin/utilities/invoice] Sign failed:", signed.error?.message);
      return NextResponse.json({ error: "Invoice file unavailable" }, { status: 404 });
    }
    return NextResponse.redirect(signed.data.signedUrl, 302);
  } catch (error) {
    console.error("[admin/utilities/invoice GET] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

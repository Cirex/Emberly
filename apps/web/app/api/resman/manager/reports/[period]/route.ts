import { NextResponse } from "next/server";
import { fetchOwnerReportFile, isValidReportPeriod } from "@/lib/manager-reports";
import { requireResmanApiKey } from "@/lib/resman-api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resman/manager/reports/[period] — streams one owner report's
 * document bytes (period = "YYYY-MM", validated). Normally the rendered PDF;
 * when the worker generated without Chromium the stored HTML streams instead
 * with its own content type — the figures were frozen either way. 404 for a
 * period that was never generated. Staff-token only, like the listing.
 */

type RouteParams = { params: Promise<{ period: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;
  if (auth.kind === "scanner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { period } = await params;
    if (!isValidReportPeriod(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    const result = await fetchOwnerReportFile(period);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return new NextResponse(result.bytes, {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `inline; filename="${result.filename}"`,
        // Frozen by construction: a period's report never changes after
        // generation (REPORT_FORCE regeneration is an operator action).
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("[resman-api manager/reports] Serve error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

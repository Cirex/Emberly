import { NextResponse } from "next/server";
import { authenticateScanner, hasScannerCredential } from "@/lib/scanner-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Who am I, and how have I been doing — the scanner's own identity and scan
 * counts for the app's settings page. Scanner-credential only: an `eapi_` API
 * token has no device identity, so there is no "me" to answer with.
 *
 * "Scans" are attempts: successful entries live in `entry_logs`; refusals are
 * only recorded as `admin_alerts` (verify-pass writes one per denial), so the
 * refused counts are read from there via metadata.scannerId.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!hasScannerCredential(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supabase = createUntypedAdminClient();
  const auth = await authenticateScanner(request, null, supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { data: device, error: deviceError } = await supabase
      .from("scanner_devices")
      .select("scanner_id, name, location, created_at")
      .eq("scanner_id", auth.scannerId)
      .maybeSingle();

    if (deviceError) throw deviceError;
    if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const since = dayStart.toISOString();
    const id = device.scanner_id as string;

    const entries = (extra: (q: EntriesQuery) => EntriesQuery) =>
      count(
        extra(
          supabase.from("entry_logs").select("id", { count: "exact", head: true }).eq("scanner_id", id),
        ),
      );
    const refusals = (extra: (q: EntriesQuery) => EntriesQuery) =>
      count(
        extra(
          supabase
            .from("admin_alerts")
            .select("id", { count: "exact", head: true })
            .in("alert_type", ["guest_pass_denied", "security_scan_denied"])
            .eq("metadata->>scannerId", id),
        ),
      );

    const [todayEntries, todayGuest, totalEntries, totalGuest, todayRefused, totalRefused] =
      await Promise.all([
        entries((q) => q.gte("entered_at", since)),
        entries((q) => q.gte("entered_at", since).eq("entry_type", "guest")),
        entries((q) => q),
        entries((q) => q.eq("entry_type", "guest")),
        refusals((q) => q.gte("created_at", since)),
        refusals((q) => q),
      ]);

    return NextResponse.json({
      data: {
        scanner: {
          id,
          name: (device.name as string) ?? "",
          location: (device.location as string) ?? null,
          activeSince: (device.created_at as string) ?? null,
        },
        today: {
          scans: todayEntries + todayRefused,
          entries: todayEntries,
          guest: todayGuest,
          refused: todayRefused,
        },
        total: {
          scans: totalEntries + totalRefused,
          entries: totalEntries,
          guest: totalGuest,
          refused: totalRefused,
        },
      },
    });
  } catch (error) {
    console.error("[scanner me] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

type EntriesQuery = ReturnType<ReturnType<UntypedSupabase["from"]>["select"]>;

async function count(query: EntriesQuery): Promise<number> {
  const { count: n, error } = await query;
  if (error) throw error;
  return n ?? 0;
}

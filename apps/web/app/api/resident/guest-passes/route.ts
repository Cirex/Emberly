import { NextRequest, NextResponse } from "next/server";
import { getGuestPassStatus } from "@emberly/core";
import { verifyRequest } from "@/lib/auth";
import { buildGuestPassUrl } from "@/lib/guest-pass-share";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const payload = verifyRequest(request);
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!payload.residentId) {
      return NextResponse.json({ error: "Resident session is missing resident identity" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status"); // active | used | expired | revoked
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 200);

    const supabase = createAdminClient();

    const { data: resident, error: residentError } = await supabase
      .from("residents")
      .select("id")
      .eq("id", payload.residentId)
      .single();

    if (residentError || !resident) {
      return NextResponse.json({ error: "Resident not found" }, { status: 404 });
    }

    let query = supabase
      .from("guest_passes")
      .select(
        "id, share_token, guest_name, guest_email, guest_phone, guest_address, expires_at, used_at, status, created_at"
      )
      .eq("resident_id", resident.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    const now = new Date().toISOString();

    if (status === "active") {
      query = query.is("used_at", null).eq("status", "active").gte("expires_at", now);
    } else if (status === "used") {
      query = query.eq("status", "used");
    } else if (status === "expired") {
      query = query.lt("expires_at", now).is("used_at", null).eq("status", "active");
    } else if (status === "revoked") {
      query = query.eq("status", "revoked");
    }

    const { data: passes, error } = await query;

    if (error) {
      console.error("[guest-passes GET] Query error:", error);
      return NextResponse.json({ error: "Failed to fetch guest passes" }, { status: 500 });
    }

    const enriched = (passes ?? []).map(({ share_token, ...p }) => ({
      ...p,
      share_url: buildGuestPassUrl(request.url, share_token),
      status: getGuestPassStatus(p, new Date(now)),
    }));

    return NextResponse.json({ passes: enriched, total: enriched.length }, { status: 200 });
  } catch (err) {
    console.error("[guest-passes GET] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

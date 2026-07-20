import { NextRequest, NextResponse } from "next/server";
import { RESIDENT_ACCESS_STALE_REASON } from "@emberly/core";
import { createResidentEntryToken, inferUnitNumber, verifyRequest } from "@/lib/auth";
import { verifyResidentDeviceSession } from "@/lib/resident-devices";
import { isResidentAccessFresh } from "@/lib/residents";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const payload = verifyRequest(request);
  if (!payload?.residentId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deviceToken = request.headers.get("x-resident-device-token");
  if (!deviceToken) {
    return NextResponse.json({ error: "Resident device session required" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const device = await verifyResidentDeviceSession(supabase, {
    residentId: payload.residentId,
    deviceToken,
  });
  if (!device.valid) {
    return NextResponse.json({ error: "Resident device session is invalid" }, { status: 401 });
  }

  const { data: resident, error } = await supabase
    .from("residents")
    .select("id, unit_id, access_allowed, last_resman_verified_at")
    .eq("id", payload.residentId)
    .single();

  if (error || !resident) {
    return NextResponse.json({ error: "Resident not found" }, { status: 404 });
  }

  if (!isResidentAccessFresh(resident)) {
    return NextResponse.json(
      { error: "Resident access needs to be refreshed", reason: RESIDENT_ACCESS_STALE_REASON },
      { status: 403 }
    );
  }

  const ttlMs = 60 * 1000;
  const now = Date.now();
  const entryToken = createResidentEntryToken(
    {
      residentId: resident.id,
      unitNumber: inferUnitNumber(resident.unit_id),
      deviceId: device.deviceId,
    },
    { now, ttlMs }
  );

  return NextResponse.json({
    entryToken,
    qrData: entryToken,
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
}

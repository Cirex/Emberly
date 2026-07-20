/**
 * POST /api/auth/select-resident
 *
 * Called after a multi-resident ResMan login when the user picks who they are.
 * Validates a short-lived Emberly selection token, then issues a resident-scoped
 * Emberly session. ResMan session cookies are never stored in the API database.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createResidentSession, verifyResidentSelectionToken, type ResidentSessionSource } from "@/lib/auth";
import { createResidentDeviceSession, ResidentDeviceSessionError } from "@/lib/resident-devices";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeSupabaseQueryFailure } from "@/lib/supabase/errors";

const Schema = z.object({
  selectionToken: z.string().min(1),
  residentId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = Schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const { selectionToken, residentId } = parsed.data;
    const selection = verifyResidentSelectionToken(selectionToken, residentId);
    if (!selection) {
      return NextResponse.json({ error: "Session expired — please sign in again" }, { status: 401 });
    }

    // Confirm the chosen resident exists
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("residents")
      .select("id, resman_ledger_id, name, unit_id")
      .eq("id", residentId)
      .eq("resman_ledger_id", selection.ledgerId)
      .single();

    const resident = data as ResidentSessionSource | null;

    if (error || !resident) {
      return NextResponse.json({ error: "Resident not found" }, { status: 404 });
    }

    const deviceSession = await createResidentDeviceSession(supabase, {
      residentId: resident.id,
      userAgent: request.headers.get("user-agent"),
    });
    const emberlySession = createResidentSession(resident);

    return NextResponse.json({
      emberlySession: {
        ...emberlySession,
        deviceSession,
      },
    });
  } catch (err) {
    console.error("[auth/select-resident]", err);
    if (err instanceof ResidentDeviceSessionError) {
      const failure = describeSupabaseQueryFailure(
        err.supabaseError && typeof err.supabaseError === "object"
          ? err.supabaseError
          : { message: err.message }
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

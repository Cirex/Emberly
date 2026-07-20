import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestSource } from "@/lib/http";
import {
  createSignedResmanPortalSession,
  createResidentSession,
  type ResidentSessionSource,
} from "@/lib/auth";
import { getAllowedPortalStatuses, resmanPortalLogin, verifyResmanPortalAccess } from "@/lib/resman-portal";
import { buildResidentProvision } from "@/lib/residents";
import { createResidentDeviceSession, ResidentDeviceSessionError } from "@/lib/resident-devices";
import { checkRateLimit } from "@/lib/rate-limit";
import { createAdminClient, getMissingSupabaseAdminEnvVars } from "@/lib/supabase/admin";
import { describeSupabaseQueryFailure } from "@/lib/supabase/errors";

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

type ResidentRow = ResidentSessionSource;

export async function POST(request: NextRequest) {
  try {
    const parsed = LoginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const username = parsed.data.username.trim();
    const loginAllowed = await checkRateLimit({
      bucket: `resman-login:${requestSource(request)}:${username.toLowerCase()}`,
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,
      failClosed: true,
    });
    if (!loginAllowed) {
      return NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
    }

    const resmanResult = await resmanPortalLogin(username, parsed.data.password);

    if (!resmanResult.success || !resmanResult.session) {
      const status = resmanResult.error === "invalid_credentials" ? 401 : 502;
      return NextResponse.json({ error: "Invalid ResMan credentials" }, { status });
    }

    const portalAccessResult = await verifyResmanPortalAccess(resmanResult.session);
    const portalAccess = {
      ...portalAccessResult,
      ...(resmanResult.tenantName ? { tenantName: resmanResult.tenantName } : {}),
    };
    if (!portalAccess.allowed) {
      return NextResponse.json(
        {
          error: "Resident is not allowed to access this application",
          reason: portalAccess.error ?? "resident_status_not_allowed",
          resmanStatus: portalAccess.status ?? null,
          unitNumber: portalAccess.unitNumber ?? null,
          allowedStatuses: getAllowedPortalStatuses(),
        },
        { status: 403 }
      );
    }

    if (!portalAccess.ledgerId) {
      return NextResponse.json(
        {
          error: "ResMan login succeeded, but no ledger identifier was found",
          reason: "resman_ledger_id_not_found",
          unitNumber: portalAccess.unitNumber ?? null,
        },
        { status: 502 }
      );
    }

    const missingSupabaseEnv = getMissingSupabaseAdminEnvVars();
    if (missingSupabaseEnv.length > 0) {
      return NextResponse.json(
        {
          error: "Emberly Web is missing Supabase configuration",
          reason: "supabase_not_configured",
          missing: missingSupabaseEnv,
        },
        { status: 503 }
      );
    }

    const supabase = createAdminClient();
    const provision = buildResidentProvision({
      username,
      portalAccess,
    });

    const { data, error } = await supabase
      .from("residents")
      .upsert(provision, { onConflict: "resman_ledger_id" })
      .select("id, resman_ledger_id, name, unit_id")
      .single();

    if (error || !data) {
      console.error("[auth/resman-session] Resident lookup failed:", error);
      const failure = describeSupabaseQueryFailure(error ?? { message: "no resident returned" });
      return NextResponse.json(failure.body, { status: failure.status });
    }

    const resident = data as ResidentRow;
    const deviceSession = await createResidentDeviceSession(supabase, {
      residentId: resident.id,
      userAgent: request.headers.get("user-agent"),
    });
    const emberlySession = createResidentSession(resident);

    return NextResponse.json({
      requiresSelection: false,
      resmanSession: createSignedResmanPortalSession(resmanResult.session),
      resmanAccess: portalAccess,
      emberlySession: {
        ...emberlySession,
        deviceSession,
      },
    });
  } catch (err) {
    console.error("[auth/resman-session]", err);
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

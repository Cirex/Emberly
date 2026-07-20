import { NextRequest, NextResponse } from "next/server";
import { mintAccessToken } from "@/lib/access-tokens";
import { authenticateResmanAdmin } from "@/lib/admin-users";
import { requestSource } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/admin/auth/app-token
 *
 * Staff sign-in for the native apps (EmberlyMaintenance). Validates ResMan
 * credentials exactly like /api/admin/auth, but instead of a browser session
 * cookie it mints a per-user `eapi_` access token (kind='api_resman',
 * subject_type='admin_user') and returns the plaintext once. The app stores it
 * in the Keychain and sends it as `Authorization: Bearer` — already accepted by
 * every /api/resman/* route, and by /api/admin/* routes via
 * requireAdminOrScanner's token branch.
 *
 * Each sign-in mints a fresh token (one per device — a tech's iPhone and iPad
 * each hold their own), so revoking one device never signs out another.
 * Revocation stays manual through the existing access-token tooling.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const { username, password, device } = {
    username: str((body as Record<string, unknown>)?.username).trim(),
    password: str((body as Record<string, unknown>)?.password),
    device: str((body as Record<string, unknown>)?.device).trim().slice(0, 64),
  };
  const source = requestSource(request);

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
  }

  // Rate-limit BEFORE the expensive ResMan round-trip so an attacker can't
  // drive unbounded outbound logins (credential-stuffing amplification / egress
  // IP block) — the check must gate the call, not just failed responses.
  const allowed = await checkRateLimit({
    bucket: `admin-app-login:${source}`,
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    failClosed: true,
  });
  if (!allowed) {
    return NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
  }

  const result = await authenticateResmanAdmin(username, password);
  if (!result.ok) {
    if (result.reason === "unavailable" || result.reason === "not_configured") {
      return NextResponse.json(
        { error: "ResMan login is temporarily unavailable. Try again shortly." },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const admin = result.admin;
  const client = createUntypedAdminClient();
  // A maintenance device gets a SCOPED role, never the person's back-office
  // role — it can read work orders/units and write map annotations + unit tags
  // (the security_manager surface), but never the super_admin routes. The staff
  // member's name rides on the label so the token is identifiable in the admin
  // access-token tooling.
  const who = admin.displayName?.trim() || username;
  const minted = await mintAccessToken(client, {
    kind: "api_resman",
    subjectType: "admin_user",
    subjectId: admin.adminId,
    label: device ? `app:maintenance · ${who} · ${device}` : `app:maintenance · ${who}`,
    role: "security_manager",
    // Pin the token to exactly the resources the maintenance app reads. The
    // security_manager role is also enforced server-side (resman-api-auth), so
    // this is defense in depth — and makes the token self-describing.
    scopes: ["units", "work-orders"],
  });

  return NextResponse.json({
    ok: true,
    token: minted.token,
    admin: {
      adminId: admin.adminId,
      // The token's effective (scoped) role, not the person's back-office role.
      role: "security_manager",
      displayName: admin.displayName,
      personId: result.personId,
    },
  });
}

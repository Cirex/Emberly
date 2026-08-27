import { NextRequest, NextResponse } from "next/server";
import { mintAccessToken } from "@/lib/access-tokens";
import { authenticateResmanAdmin } from "@/lib/admin-users";
import { requestSource } from "@/lib/http";
import { appRoleScopes } from "@/lib/resman-api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/admin/auth/app-token
 *
 * Staff sign-in for the native apps (EmberlyMaintenance, EmberlyManager —
 * `app` in the body says which, defaulting to maintenance). Validates ResMan
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
  const { username, password, device, app } = {
    username: str((body as Record<string, unknown>)?.username).trim(),
    password: str((body as Record<string, unknown>)?.password),
    device: str((body as Record<string, unknown>)?.device).trim().slice(0, 64),
    app: str((body as Record<string, unknown>)?.app).trim(),
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
  // A device gets a SCOPED role, never the person's back-office role — never
  // the super_admin routes, and never a surface belonging to a DIFFERENT app.
  // The two native apps ask for very different things: EmberlyMaintenance wants
  // work orders and units; EmberlyManager wants the rent ledger, lease terms,
  // MLGW billing and the resident roster. Minting one role for both meant a
  // tech's phone carried a credential for the whole back office, so the app
  // names itself here and gets only its own capabilities.
  //
  // Maintenance mints `maintenance_tech`. It used to mint `security_manager`,
  // which happened to carry the right capability set (units, work-orders) but
  // whose name read as a permissions bug in the app UI and muddied audits.
  // `security_manager` is NOT retired: it stays the scanner's effective role,
  // a real back-office role for humans, and the role on every maintenance
  // token minted before this rename — all of which every gate still accepts.
  //
  // `app` is absent on installs that predate this field; they are all
  // maintenance builds, so that stays the default.
  const isManager = app === "manager";
  const role = isManager ? "property_manager" : "maintenance_tech";
  const appLabel = isManager ? "app:manager" : "app:maintenance";
  const who = admin.displayName?.trim() || username;
  const minted = await mintAccessToken(client, {
    kind: "api_resman",
    subjectType: "admin_user",
    subjectId: admin.adminId,
    label: device ? `${appLabel} · ${who} · ${device}` : `${appLabel} · ${who}`,
    role,
    // Pin the token to exactly the capabilities its role allows. The role is
    // also enforced server-side (resman-api-auth), so this is defense in depth
    // — and makes the token self-describing in the admin token tooling.
    scopes: appRoleScopes(role),
  });

  return NextResponse.json({
    ok: true,
    token: minted.token,
    admin: {
      adminId: admin.adminId,
      // The token's effective (scoped) role, not the person's back-office role.
      role,
      displayName: admin.displayName,
      personId: result.personId,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { authenticateResmanAdminSession } from "@/lib/admin-users";
import { requestSource } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/admin/auth/resman-session
 *
 * Silent ResMan session RENEWAL for the maintenance app: the device holds the
 * technician's credentials in its Keychain, and when ResMan idle-times the
 * device session out, the app posts them here; the server runs the proven
 * staff login (the device's own dance fails on React Native's HTTP stack) and
 * returns the fresh session cookies for the app to inject into its native
 * cookie store. Credential-authenticated by construction — the login IS the
 * check, including the admin_users gate. Cookies are returned once and never
 * persisted or logged; the session lives only on the device.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const username = str((body as Record<string, unknown>)?.username).trim();
  const password = str((body as Record<string, unknown>)?.password);
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
  }

  // Rate-limit BEFORE the expensive ResMan round-trip, same reasoning as
  // app-token: never let a caller drive unbounded outbound logins.
  const source = requestSource(request);
  const allowed = await checkRateLimit({
    bucket: `resman-session:${source}`,
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    failClosed: true,
  });
  if (!allowed) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const result = await authenticateResmanAdminSession(username, password);
  if (!result.ok) {
    if (result.reason === "unavailable" || result.reason === "not_configured") {
      return NextResponse.json(
        { error: "ResMan login is temporarily unavailable. Try again shortly." },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, cookies: result.resmanCookies ?? [] });
}

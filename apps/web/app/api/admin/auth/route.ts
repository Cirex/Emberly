import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@emberly/core";
import { requestSource } from "@/lib/http";
import { createAdminSessionToken, type AdminAuthContext } from "@/lib/auth";
import { authenticateBreakGlass, authenticateResmanAdmin } from "@/lib/admin-users";
import { checkRateLimit } from "@/lib/rate-limit";

function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/admin/login";
  }

  try {
    const parsed = new URL(value, "https://emberly.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/admin/login";
  }
}

async function readCredentials(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  if (contentType.includes("application/json")) {
    const body = await request.json();
    return {
      username: str(body.username).trim(),
      password: str(body.password),
      breakGlass: str(body.breakGlass).trim(),
      json: true,
      returnTo: safeReturnTo(body.returnTo),
    };
  }

  const formData = await request.formData();
  return {
    username: str(formData.get("username")).trim(),
    password: str(formData.get("password")),
    breakGlass: str(formData.get("breakGlass")).trim(),
    json: false,
    returnTo: safeReturnTo(formData.get("returnTo")),
  };
}

function authError(message: string, status: number, json: boolean, returnTo: string) {
  if (json) {
    return NextResponse.json({ error: message }, { status });
  }

  const errorCode = status === 429 ? "rate_limited" : "invalid";
  const separator = returnTo.includes("?") ? "&" : "?";
  return new NextResponse(null, {
    status: 303,
    headers: { location: `${returnTo}${separator}error=${errorCode}` },
  });
}

function authSuccess(json: boolean, admin: AdminAuthContext) {
  const response = json
    ? NextResponse.json({ ok: true, admin })
    : new NextResponse(null, { status: 303, headers: { location: "/admin" } });

  response.cookies.set(ADMIN_SESSION_COOKIE, createAdminSessionToken(admin), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 8, // 8 hours
    path: "/",
  });

  return response;
}

/**
 * POST /api/admin/auth
 * Validates the admin key and sets a session cookie.
 */
export async function POST(request: NextRequest) {
  try {
    const { username, password, breakGlass, json, returnTo } = await readCredentials(request);
    const source = requestSource(request);

    // Rate-limit BEFORE the outbound ResMan login round-trip (a password
    // attempt) so an attacker can't drive unbounded logins against ResMan
    // ahead of the bucket biting. Break-glass is local and not rate-limited.
    if (!breakGlass) {
      const allowed = await checkRateLimit({
        bucket: `admin-login:${source}`,
        maxAttempts: 10,
        windowMs: 15 * 60 * 1000,
        failClosed: true,
      });
      if (!allowed) {
        return authError("Too many login attempts", 429, json, returnTo);
      }
    }

    let admin: AdminAuthContext | null = null;
    if (breakGlass) {
      admin = authenticateBreakGlass(breakGlass);
    } else if (username && password) {
      const result = await authenticateResmanAdmin(username, password);
      if (result.ok) {
        admin = result.admin;
      } else if (result.reason === "unavailable" || result.reason === "not_configured") {
        return authError("ResMan login is temporarily unavailable. Try again shortly.", 502, json, returnTo);
      }
    }

    if (!admin) {
      return authError("Invalid credentials", 401, json, returnTo);
    }

    return authSuccess(json, admin);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

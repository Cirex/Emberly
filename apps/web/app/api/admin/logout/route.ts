import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@emberly/core";

export async function POST() {
  // Use a RELATIVE Location so the browser resolves it against the public origin
  // it is actually on. Behind a reverse proxy (Coolify), request.url is the
  // container's internal bind (http://0.0.0.0:3000), which must never leak into
  // the redirect — building `new URL("/admin/login", request.url)` sent users to
  // https://0.0.0.0:3000/admin/login. 303 converts the logout POST into a GET of
  // the login page. Mirrors the relative-Location redirects in ../auth/route.ts.
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: "/admin/login" },
  });
  response.cookies.delete(ADMIN_SESSION_COOKIE);
  return response;
}

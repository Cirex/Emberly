import { z } from "zod";
import type { StaffAdmin } from "@/lib/stores/config";

/**
 * Staff sign-in: exchanges ResMan credentials for a per-user `eapi_` token via
 * POST /api/admin/auth/app-token. Credentials go over the wire once and are
 * never stored on the device — only the returned token is.
 */

/** A ResMan session cookie the SERVER established on our behalf — the app
 *  injects these into its native cookie store (the device's own login dance
 *  trips ResMan's new-device challenge; the server's egress IP is trusted). */
export const ResmanSessionCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().default("/"),
  expires: z.string().nullable().default(null),
});
export type ResmanSessionCookie = z.infer<typeof ResmanSessionCookieSchema>;

const SignInResponse = z.object({
  ok: z.literal(true),
  token: z.string().min(1),
  admin: z.object({
    adminId: z.string(),
    role: z.string(),
    displayName: z.string(),
    personId: z.string().nullish(),
  }),
  // Present for maintenance sign-ins on servers that perform the ResMan
  // login; tolerated absent so older servers keep working.
  resmanSession: z.object({ cookies: z.array(ResmanSessionCookieSchema) }).optional(),
});

export type SignInResult =
  | {
      ok: true;
      token: string;
      admin: StaffAdmin;
      resmanSession?: { cookies: ResmanSessionCookie[] };
    }
  | { ok: false; reason: "invalid" | "rate_limited" | "unavailable" | "unreachable" };

export async function signInWithResman(input: {
  baseUrl: string;
  username: string;
  password: string;
  device?: string;
}): Promise<SignInResult> {
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}/api/admin/auth/app-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        device: input.device ?? "",
        // Names the app so the server mints the maintenance role — work orders
        // and units, never the back-office manager surface.
        app: "maintenance",
      }),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (response.ok) {
    try {
      const parsed = SignInResponse.parse(await response.json());
      return {
        ok: true,
        token: parsed.token,
        admin: parsed.admin,
        resmanSession: parsed.resmanSession,
      };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }
  if (response.status === 429) return { ok: false, reason: "rate_limited" };
  if (response.status === 502) return { ok: false, reason: "unavailable" };
  return { ok: false, reason: "invalid" };
}

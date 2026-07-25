import { z } from "zod";
import type { StaffAdmin } from "@/lib/stores/config";

/**
 * Staff sign-in: exchanges ResMan credentials for a per-user `eapi_` token via
 * POST /api/admin/auth/app-token. Credentials go over the wire once and are
 * never stored on the device — only the returned token is.
 */

const SignInResponse = z.object({
  ok: z.literal(true),
  token: z.string().min(1),
  admin: z.object({
    adminId: z.string(),
    role: z.string(),
    displayName: z.string(),
    personId: z.string().nullish(),
  }),
});

export type SignInResult =
  | { ok: true; token: string; admin: StaffAdmin }
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
        // Names the app so the server mints the manager role. The two apps
        // share this endpoint but not their surfaces — without this the token
        // comes back scoped to maintenance and every manager screen 403s.
        app: "manager",
      }),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (response.ok) {
    try {
      const parsed = SignInResponse.parse(await response.json());
      return { ok: true, token: parsed.token, admin: parsed.admin };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }
  if (response.status === 429) return { ok: false, reason: "rate_limited" };
  if (response.status === 502) return { ok: false, reason: "unavailable" };
  return { ok: false, reason: "invalid" };
}

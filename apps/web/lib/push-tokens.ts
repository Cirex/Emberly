/**
 * Expo push-token registry for the staff apps (public.push_tokens).
 *
 * The maintenance app registers its device token after staff sign-in and
 * deactivates it on sign-out; the sync worker reads the active rows to fan
 * emergency work-order alerts out. Schemas + row builders live here so the
 * route handler stays a thin auth/validate/delegate shell and the logic is
 * unit-testable without Next.js.
 */
import { z } from "zod";
import type { AdminAuthContext } from "./auth";
import type { UntypedSupabase } from "./supabase/types";

export const PUSH_TOKENS_TABLE = "push_tokens";

/** POST /api/admin/push-tokens — register or refresh a device token. */
export const RegisterPushTokenSchema = z.object({
  token: z.string().min(1).max(512),
  platform: z.enum(["ios", "android"]).optional(),
});

/** DELETE /api/admin/push-tokens — deactivate a device token (sign-out). */
export const DeletePushTokenSchema = z.object({
  token: z.string().min(1).max(512),
});

export type RegisterPushTokenInput = z.infer<typeof RegisterPushTokenSchema>;

/** Row for the register/refresh upsert (conflict target: expo_push_token). */
export function buildPushTokenUpsert(
  admin: AdminAuthContext,
  input: RegisterPushTokenInput,
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    expo_push_token: input.token,
    admin_id: admin.adminId,
    display_name: admin.displayName ?? "",
    platform: input.platform ?? "ios",
    app: "maintenance",
    active: true,
    last_seen_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

/** Upsert-by-token: re-registering flips a signed-out token active again. */
export async function registerPushToken(
  client: UntypedSupabase,
  admin: AdminAuthContext,
  input: RegisterPushTokenInput,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await client
    .from(PUSH_TOKENS_TABLE)
    .upsert(buildPushTokenUpsert(admin, input, now), { onConflict: "expo_push_token" });
  if (error) throw new Error(`push token upsert failed: ${error.message}`);
}

/**
 * Sign-out path: mark the token inactive. Idempotent — an unknown or already
 * inactive token is a successful no-op (the app can always safely call this).
 */
export async function deactivatePushToken(client: UntypedSupabase, token: string): Promise<void> {
  const { error } = await client
    .from(PUSH_TOKENS_TABLE)
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("expo_push_token", token);
  if (error) throw new Error(`push token deactivate failed: ${error.message}`);
}

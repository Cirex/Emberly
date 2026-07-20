import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { UntypedSupabase } from "./types";

/**
 * The Supabase project URL for the service-role client. Read `SUPABASE_URL`
 * first — a plain runtime var — falling back to the legacy `NEXT_PUBLIC_SUPABASE_URL`
 * for backward compatibility.
 *
 * IMPORTANT: this value is consumed ONLY server-side (there is no browser
 * Supabase client). A `NEXT_PUBLIC_`-prefixed var is INLINED at build time by
 * Next.js, so under a Docker/standalone deploy it bakes in whatever was present
 * during `next build` and can't be supplied at runtime. `SUPABASE_URL` has no
 * such prefix, so it is a true runtime read and can be set in the container's
 * environment (e.g. Coolify) without a rebuild.
 */
function resolveSupabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined;
}

export function getMissingSupabaseAdminEnvVars(): string[] {
  const missing: string[] = [];
  if (!resolveSupabaseUrl()) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}

/**
 * Service-role Supabase client.
 * Bypasses Row-Level Security — use only in trusted server-side contexts (API routes).
 * Never expose this client to the browser.
 */
export function createAdminClient() {
  const missing = getMissingSupabaseAdminEnvVars();
  const supabaseUrl = resolveSupabaseUrl();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (missing.length > 0 || !supabaseUrl || !serviceRoleKey) {
    throw new Error(
      `Missing ${missing.join(" or ")} environment variables`
    );
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/** The service-role client typed loosely, for queries the generated Database
 *  types don't cover. Centralizes the `as unknown as UntypedSupabase` cast. */
export function createUntypedAdminClient(): UntypedSupabase {
  return createAdminClient() as unknown as UntypedSupabase;
}

/**
 * Environment variable names consumed by the sync worker.
 *
 * Credentials live ONLY in the Coolify worker's secret store — never in the
 * Vercel/web env and never in the iOS app (design §5.4). This centralization
 * is what closes the known iOS hardcoded-ResMan-password issue: with sync run
 * server-side, iPads never hold ResMan credentials at all.
 *
 * Milestone 0: names only. The loader/validator is filled in with the jobs
 * (Milestone 6, Coolify orchestration).
 */
export const ENV = {
  // ResMan (Coolify secrets)
  RESMAN_SYNC_USERNAME: "RESMAN_SYNC_USERNAME",
  RESMAN_SYNC_PASSWORD: "RESMAN_SYNC_PASSWORD",
  RESMAN_ACCOUNT_ID: "RESMAN_ACCOUNT_ID",
  RESMAN_SUBDOMAIN: "RESMAN_SUBDOMAIN",
  // The ResMan property id the reports filter on (PropertyOrGroupIDs).
  RESMAN_PROPERTY_ID: "RESMAN_PROPERTY_ID",

  // MLGW (Coolify secrets + tuning)
  MLGW_SYNC_USERNAME: "MLGW_SYNC_USERNAME",
  MLGW_SYNC_PASSWORD: "MLGW_SYNC_PASSWORD",
  MLGW_SYNC_RESTART_ATTEMPTS: "MLGW_SYNC_RESTART_ATTEMPTS",
  MLGW_BILL_PAGE_SIZE: "MLGW_BILL_PAGE_SIZE",
  XMS_MLGW_DEBUG_LOGS: "XMS_MLGW_DEBUG_LOGS",

  // Supabase (service role bypasses RLS). SUPABASE_URL is the canonical runtime
  // var; NEXT_PUBLIC_SUPABASE_URL is accepted as a legacy fallback so a single
  // SUPABASE_URL can be shared with the web app's server-side client.
  SUPABASE_URL: "SUPABASE_URL",
  SUPABASE_URL_LEGACY: "NEXT_PUBLIC_SUPABASE_URL",
  SUPABASE_SERVICE_ROLE_KEY: "SUPABASE_SERVICE_ROLE_KEY",

  // Langbly (translation pre-cache). Optional: with no key the
  // translate-work-orders job no-ops, so the pipeline stays deployable.
  LANGBLY_API_KEY: "LANGBLY_API_KEY",
  LANGBLY_API_URL: "LANGBLY_API_URL",
} as const;

export type EnvVarName = (typeof ENV)[keyof typeof ENV];

/**
 * A read-only environment lookup — `process.env` in production, or a plain
 * object in tests. Modules accept this so credential/config reads are injectable
 * and never depend on the ambient process environment during unit tests.
 */
export type EnvRecord = Record<string, string | undefined>;

/** Read a required env var, throwing a clear error when it is missing/blank. */
export function requireEnv(env: EnvRecord, name: EnvVarName): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export interface SupabaseCredentials {
  url: string;
  serviceRoleKey: string;
}

export function loadSupabaseCredentials(env: EnvRecord): SupabaseCredentials {
  const url = env[ENV.SUPABASE_URL]?.trim() || env[ENV.SUPABASE_URL_LEGACY]?.trim();
  if (!url) throw new Error(`Missing required environment variable: ${ENV.SUPABASE_URL}`);
  return {
    url,
    serviceRoleKey: requireEnv(env, ENV.SUPABASE_SERVICE_ROLE_KEY),
  };
}

export interface ResmanCredentials {
  username: string;
  password: string;
  accountId: string;
  subdomain: string;
}

export function loadResmanCredentials(env: EnvRecord): ResmanCredentials {
  return {
    username: requireEnv(env, ENV.RESMAN_SYNC_USERNAME),
    password: requireEnv(env, ENV.RESMAN_SYNC_PASSWORD),
    // Account/subdomain default to the MultiSouth preset (resman/config.ts).
    accountId: env[ENV.RESMAN_ACCOUNT_ID]?.trim() || "1659",
    subdomain: env[ENV.RESMAN_SUBDOMAIN]?.trim() || "multisouth",
  };
}

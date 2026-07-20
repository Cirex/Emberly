/**
 * Runnable entry — sync ResMan units into Supabase, once.
 *
 *   RESMAN_SYNC_USERNAME=... RESMAN_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   yarn workspace @emberly/sync sync:units
 *
 * (Coolify runs this on a schedule; run it by hand once to verify the port.)
 */
import { ENV } from "./config/env";
import { createServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { syncUnits } from "./resman/jobs/units";

async function main(): Promise<void> {
  const env = process.env;
  const propertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  if (!propertyId) {
    throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);
  }

  const configuration = resManConfigurationFromEnv(env);
  const credentials = resManCredentialsFromEnv(env);
  const supabase = createServiceClient(env);
  const client = new ResManClient(configuration, {
    credentials,
    log: (m) => console.log(m),
  });

  const result = await syncUnits({
    client,
    supabase,
    propertyId,
    credentials,
    log: (m) => console.log(m),
  });

  console.log("[run-units] complete:", JSON.stringify(result));
}

main().catch((error) => {
  console.error("[run-units] failed:", error);
  process.exit(1);
});
